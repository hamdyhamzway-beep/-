import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  setPersistence,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Ensure Firebase Authentication stays persisted locally across app restarts/reloads
setPersistence(auth, browserLocalPersistence).catch(() => {
  // Ignore persistence errors in restricted browser environments
});

export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });
