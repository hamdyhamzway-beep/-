import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';
import { apiFetch, getDriverSessionToken, setDriverSessionToken } from '../lib/api';
import type { DbUser } from '../types';

interface AuthContextValue {
  firebaseUser: User | null;
  isAuthenticated: boolean;
  dbUser: DbUser | null;
  driverRecord: { id: number; driverCode: string; fullName: string } | null;
  loading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  loginWithGoogle: () => Promise<void>;
  loginDriverWithPhoneCode: (phone: string, driverCode: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [isDriverSession, setIsDriverSession] = useState<boolean>(() =>
    Boolean(getDriverSessionToken())
  );
  const [dbUser, setDbUser] = useState<DbUser | null>(null);
  const [driverRecord, setDriverRecord] = useState<{
    id: number;
    driverCode: string;
    fullName: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const fetchDbProfile = useCallback(async (clearOnFailure = false) => {
    try {
      const data = await apiFetch<{
        user: DbUser;
        driver: { id: number; driverCode: string; fullName: string } | null;
      }>('/api/me');
      setDbUser(data.user);
      setDriverRecord(data.driver);
      setAuthError(null);
      return true;
    } catch (err: unknown) {
      if (clearOnFailure) {
        setDriverSessionToken(null);
        setIsDriverSession(false);
        setDbUser(null);
        setDriverRecord(null);
        setAuthError(null);
      } else {
        setAuthError(err instanceof Error ? err.message : 'تعذر التحقق من صلاحيات الحساب');
      }
      return false;
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        setDriverSessionToken(null);
        setIsDriverSession(false);
        await fetchDbProfile(false);
      } else if (getDriverSessionToken()) {
        setIsDriverSession(true);
        await fetchDbProfile(true);
      } else {
        setIsDriverSession(false);
        setDbUser(null);
        setDriverRecord(null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, [fetchDbProfile]);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const loginWithGoogle = async () => {
    setAuthError(null);
    setDriverSessionToken(null);
    setIsDriverSession(false);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setAuthError('تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.');
      } else if (code === 'auth/popup-blocked') {
        setAuthError('المتصفح حظر نافذة تسجيل الدخول المنبثقة. يرجى السماح بالنوافذ المنبثقة وإعادة المحاولة.');
      } else if (code === 'auth/unauthorized-domain') {
        setAuthError('هذا النطاق غير مصرح به في إعدادات Firebase Auth للمشروع. يرجى إضافته في Authorized domains.');
      } else if (code === 'auth/network-request-failed') {
        setAuthError('تعذر الاتصال بخادم المصادقة. يرجى التحقق من اتصال الإنترنت.');
      } else {
        const msg = err instanceof Error ? err.message : 'فشل تسجيل الدخول باستخدام Google';
        setAuthError(msg);
      }
    }
  };

  const loginDriverWithPhoneCode = async (phone: string, driverCode: string) => {
    setAuthError(null);
    try {
      const res = await fetch('/api/auth/driver-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, driverCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || 'فشل تسجيل دخول السائق';
        setAuthError(msg);
        throw new Error(msg);
      }

      setDriverSessionToken(data.token);
      if (auth.currentUser) {
        await signOut(auth);
      }
      setIsDriverSession(true);
      setDbUser(data.user);
      setDriverRecord(data.driver);
      setAuthError(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر تسجيل الدخول برقم الموبايل والكود';
      setAuthError(msg);
      throw err;
    }
  };

  const logout = async () => {
    setDriverSessionToken(null);
    setIsDriverSession(false);
    if (auth.currentUser) {
      await signOut(auth);
    }
    setDbUser(null);
    setDriverRecord(null);
    setAuthError(null);
  };

  const isAuthenticated = Boolean((firebaseUser || isDriverSession) && dbUser);

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        isAuthenticated,
        dbUser,
        driverRecord,
        loading,
        authError,
        clearAuthError,
        loginWithGoogle,
        loginDriverWithPhoneCode,
        logout,
        refreshProfile: async () => {
          await fetchDbProfile(false);
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
