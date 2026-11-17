import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, onIdTokenChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';
import {
  ApiHttpError,
  apiFetch,
  getDriverSessionToken,
  restoreDriverSessionToken,
  setDriverSessionToken,
} from '../lib/api';
import {
  clearCachedSession,
  getCachedSession,
  saveCachedSession,
} from '../lib/local-store';
import type { DbUser } from '../types';

export interface DriverSessionIdentity {
  id: number;
  driverCode: string;
  fullName: string;
}

export interface SupervisorSessionIdentity {
  id: number;
  supervisorCode: string;
  fullName: string;
  phone: string;
}

interface AuthContextValue {
  firebaseUser: User | null;
  isAuthenticated: boolean;
  dbUser: DbUser | null;
  driverRecord: DriverSessionIdentity | null;
  supervisorRecord: SupervisorSessionIdentity | null;
  loading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  loginWithGoogle: () => Promise<void>;
  loginDriverWithPhoneCode: (identifier: string, driverCode: string) => Promise<void>;
  loginSupervisorWithPhoneCode: (identifier: string, supervisorCode: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [isCodeSession, setIsCodeSession] = useState<boolean>(() =>
    Boolean(getDriverSessionToken())
  );
  const [dbUser, setDbUser] = useState<DbUser | null>(null);
  const [driverRecord, setDriverRecord] = useState<DriverSessionIdentity | null>(null);
  const [supervisorRecord, setSupervisorRecord] = useState<SupervisorSessionIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const manualLoginInProgressRef = useRef(false);

  const clearSessionState = useCallback(async () => {
    setDriverSessionToken(null);
    setIsCodeSession(false);
    setDbUser(null);
    setDriverRecord(null);
    setSupervisorRecord(null);
    await clearCachedSession();
  }, []);

  const fetchDbProfile = useCallback(
    async (isTokenSession = false) => {
      try {
        const data = await apiFetch<{
          user: DbUser;
          driver: DriverSessionIdentity | null;
          supervisor: SupervisorSessionIdentity | null;
          refreshedSessionToken?: string | null;
        }>('/api/me');

        if (data.refreshedSessionToken && isTokenSession) {
          setDriverSessionToken(data.refreshedSessionToken);
        }

        setDbUser(data.user);
        setDriverRecord(data.driver);
        setSupervisorRecord(data.supervisor || null);
        setAuthError(null);

        await saveCachedSession({
          dbUser: data.user,
          driverRecord: data.driver,
          supervisorRecord: data.supervisor || null,
        });
        return true;
      } catch (err: unknown) {
        const status = err instanceof ApiHttpError ? err.status : 0;

        // If Firebase session got 401 once, force-refresh token and try /api/me once more before failing
        if (!isTokenSession && status === 401 && auth.currentUser) {
          try {
            await auth.currentUser.getIdToken(true);
            const retryData = await apiFetch<{
              user: DbUser;
              driver: DriverSessionIdentity | null;
              supervisor: SupervisorSessionIdentity | null;
            }>('/api/me');
            setDbUser(retryData.user);
            setDriverRecord(retryData.driver);
            setSupervisorRecord(retryData.supervisor || null);
            setAuthError(null);
            await saveCachedSession({
              dbUser: retryData.user,
              driverRecord: retryData.driver,
              supervisorRecord: retryData.supervisor || null,
            });
            return true;
          } catch {
            // Fall through to confirmed failure handling below
          }
        }

        // Only wipe persistent local session on confirmed invalid/revoked credentials (401/403).
        // Never wipe on offline boot (status 0) or transient server errors (5xx / 503).
        if (status === 401 || status === 403) {
          if (isTokenSession) {
            await clearSessionState();
          } else {
            setDbUser(null);
            setDriverRecord(null);
            setSupervisorRecord(null);
            setAuthError(err instanceof Error ? err.message : 'انتهت صلاحية الجلسة');
          }
          return false;
        }

        // Fallback to cached session when network/server is temporarily unreachable (0 or 5xx)
        const cached = await getCachedSession();
        if (cached && cached.dbUser) {
          setDbUser(cached.dbUser);
          setDriverRecord(cached.driverRecord);
          setSupervisorRecord(cached.supervisorRecord || null);
          setAuthError(null);
          return true;
        }

        if (!isTokenSession) {
          setAuthError(err instanceof Error ? err.message : 'تعذر التحقق من صلاحيات الحساب');
        }
        return false;
      }
    },
    [clearSessionState]
  );

  // Instant hydration from IndexedDB cache on mount (including token recovery if localStorage was cleared)
  useEffect(() => {
    let active = true;
    (async () => {
      const recoveredToken = await restoreDriverSessionToken();
      if (!active) return;
      if (recoveredToken) {
        setIsCodeSession(true);
      }
      const cached = await getCachedSession();
      if (!active || !cached?.dbUser) return;
      if (recoveredToken || auth.currentUser) {
        setDbUser((prev) => prev || cached.dbUser);
        setDriverRecord((prev) => prev || cached.driverRecord);
        setSupervisorRecord((prev) => prev || cached.supervisorRecord || null);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (manualLoginInProgressRef.current) {
        return;
      }
      setFirebaseUser(user);
      if (user) {
        setDriverSessionToken(null);
        setIsCodeSession(false);
        await fetchDbProfile(false);
      } else {
        const codeToken = await restoreDriverSessionToken();
        if (codeToken) {
          setIsCodeSession(true);
          await fetchDbProfile(true);
        } else {
          setIsCodeSession(false);
          setDbUser(null);
          setDriverRecord(null);
          setSupervisorRecord(null);
        }
      }
      setLoading(false);
    });

    // Keep Firebase user object synced cleanly when Firebase rotates ID tokens silently
    const unsubToken = onIdTokenChanged(auth, (user) => {
      if (manualLoginInProgressRef.current) return;
      if (user) {
        setFirebaseUser(user);
      }
    });

    return () => {
      unsubAuth();
      unsubToken();
    };
  }, [fetchDbProfile]);

  // Proactive Firebase ID token keep-alive (prevents 1-hour expiry logout after idle or mobile sleep)
  useEffect(() => {
    if (!firebaseUser) return;

    const refreshFirebaseTokenSilently = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      firebaseUser.getIdToken(true).catch(() => {
        // Ignore transient network errors; apiFetch & offline cache handle temporary disconnects
      });
    };

    const intervalId = window.setInterval(refreshFirebaseTokenSilently, 35 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshFirebaseTokenSilently();
      }
    };
    const onOnline = () => refreshFirebaseTokenSilently();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [firebaseUser]);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const loginWithGoogle = async () => {
    setAuthError(null);
    setDriverSessionToken(null);
    setIsCodeSession(false);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setAuthError('تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.');
      } else if (code === 'auth/popup-blocked') {
        setAuthError(
          'المتصفح حظر نافذة تسجيل الدخول المنبثقة. يرجى السماح بالنوافذ المنبثقة وإعادة المحاولة.'
        );
      } else if (code === 'auth/unauthorized-domain') {
        setAuthError(
          'هذا النطاق غير مصرح به في إعدادات Firebase Auth للمشروع. يرجى إضافته في Authorized domains.'
        );
      } else if (code === 'auth/network-request-failed') {
        setAuthError('تعذر الاتصال بخادم المصادقة. يرجى التحقق من اتصال الإنترنت.');
      } else {
        const msg = err instanceof Error ? err.message : 'فشل تسجيل الدخول باستخدام Google';
        setAuthError(msg);
      }
    }
  };

  const loginDriverWithPhoneCode = async (identifier: string, driverCode: string) => {
    setAuthError(null);
    manualLoginInProgressRef.current = true;
    try {
      const res = await fetch('/api/auth/driver-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, phone: identifier, driverCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || 'فشل تسجيل دخول السائق';
        setAuthError(msg);
        throw new Error(msg);
      }

      setDriverSessionToken(data.token);
      if (auth.currentUser) {
        await signOut(auth).catch(() => undefined);
      }
      setFirebaseUser(null);
      setIsCodeSession(true);
      setDbUser(data.user);
      setDriverRecord(data.driver);
      setSupervisorRecord(null);
      setAuthError(null);
      await saveCachedSession({
        dbUser: data.user,
        driverRecord: data.driver,
        supervisorRecord: null,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'تعذر تسجيل الدخول برقم الموبايل أو الاسم والكود';
      setAuthError(msg);
      throw err;
    } finally {
      manualLoginInProgressRef.current = false;
    }
  };

  const loginSupervisorWithPhoneCode = async (identifier: string, supervisorCode: string) => {
    setAuthError(null);
    manualLoginInProgressRef.current = true;
    try {
      const res = await fetch('/api/auth/supervisor-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, phone: identifier, supervisorCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || 'فشل تسجيل دخول المشرفة';
        setAuthError(msg);
        throw new Error(msg);
      }

      setDriverSessionToken(data.token);
      if (auth.currentUser) {
        await signOut(auth).catch(() => undefined);
      }
      setFirebaseUser(null);
      setIsCodeSession(true);
      setDbUser(data.user);
      setDriverRecord(null);
      setSupervisorRecord(data.supervisor);
      setAuthError(null);
      await saveCachedSession({
        dbUser: data.user,
        driverRecord: null,
        supervisorRecord: data.supervisor,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'تعذر تسجيل دخول المشرفة برقم الموبايل أو الاسم والكود';
      setAuthError(msg);
      throw err;
    } finally {
      manualLoginInProgressRef.current = false;
    }
  };

  const logout = async () => {
    await clearSessionState();
    if (auth.currentUser) {
      await signOut(auth);
    }
    setAuthError(null);
  };

  const isAuthenticated = Boolean((firebaseUser || isCodeSession) && dbUser);

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        isAuthenticated,
        dbUser,
        driverRecord,
        supervisorRecord,
        loading,
        authError,
        clearAuthError,
        loginWithGoogle,
        loginDriverWithPhoneCode,
        loginSupervisorWithPhoneCode,
        logout,
        refreshProfile: async () => {
          await fetchDbProfile(Boolean(getDriverSessionToken()));
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
