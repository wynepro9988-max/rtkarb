import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, post, setCsrfToken } from './api.ts';

export interface Me {
  user: { id: string; email: string; fullName: string };
  mode: 'tenant' | 'support' | 'platform';
  organization: { id: string; name: string; timezone: string } | null;
  membership: { id: string; role: string; roleLabel: string; isTherapist: boolean } | null;
  permissions: string[];
  csrfToken: string;
  support: { grantId: string; expiresAt: string; scopes: string[] } | null;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (...perms: string[]) => boolean;
  reload: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await get<Me>('/auth/me');
      setCsrfToken(data.csrfToken);
      setMe(data);
      return data;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === 401) setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onUnauthorized = () => setMe(null);
    window.addEventListener('rb:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rb:unauthorized', onUnauthorized);
  }, [reload]);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setCsrfToken('');
      setMe(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      // Hanya untuk menampilkan/menyembunyikan menu. Otorisasi sebenarnya selalu di server.
      can: (...perms) => Boolean(me && perms.some((p) => me.permissions.includes(p))),
      reload,
      logout,
    }),
    [me, loading, reload, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth di luar AuthProvider');
  return ctx;
}
