import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  getAuth,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  setPersistence,
  type Auth,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

function createPersistentAuth(): Auth {
  try {
    return initializeAuth(app, {
      persistence: [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        browserSessionPersistence,
      ],
    });
  } catch {
    const existing = getAuth(app);
    setPersistence(existing, browserLocalPersistence).catch(() => {
      // Ignore persistence errors in restricted browser environments
    });
    return existing;
  }
}

export const auth = createPersistentAuth();

export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });
