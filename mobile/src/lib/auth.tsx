// Who is signed in. Screens read it with useAuth().
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, loadSession, setSignedOutHandler, signIn as apiSignIn, signOut as apiSignOut, type Me } from './api';
import { registerForPush, getRegisteredToken } from './push';

type AuthState = {
  ready: boolean;
  me: Me | null;
  signIn: (server: string, email: string, password: string, code?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(async () => { setMe(await api.me()); }, []);

  useEffect(() => {
    setSignedOutHandler(() => setMe(null));
    (async () => {
      const { session } = await loadSession();
      if (session) {
        try { setMe(await api.me()); registerForPush().catch(() => {}); } catch { /* expired: show sign-in */ }
      }
      setReady(true);
    })();
  }, []);

  const signIn = useCallback(async (server: string, email: string, password: string, code?: string) => {
    await apiSignIn(server, email, password, code);
    setMe(await api.me());
    registerForPush().catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    await apiSignOut(await getRegisteredToken());
    setMe(null);
  }, []);

  return <Ctx.Provider value={{ ready, me, signIn, signOut, refreshMe }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
