import React, { createContext, useState, useContext, useEffect } from 'react';
import { authService, consumeLegacyAuthTokenMigration } from '@/api/auth';
import { API_BASE_URL, API_ENDPOINT_CONFIGURED, API_ENDPOINT_TRUST } from '@/api/client';
import { notifyUserError } from '@/lib/userFeedback';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(() => Boolean(API_BASE_URL));
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings, setAppPublicSettings] = useState({
    public_settings: { requires_auth: false },
  });

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    setIsLoadingPublicSettings(false);
    setAuthError(null);

    if (API_ENDPOINT_CONFIGURED && !API_BASE_URL) {
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      setAuthError({
        type: 'backend_config_error',
        message: API_ENDPOINT_TRUST.error || 'Backend API URL is not trusted.',
      });
      return;
    }

    if (!API_BASE_URL) {
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      return;
    }

    if (consumeLegacyAuthTokenMigration()) {
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      setAuthError({
        type: 'auth_required',
        message: 'Authentication required',
      });
      return;
    }

    await checkUserAuth();
  };

  const checkUserAuth = async () => {
    try {
      setIsLoadingAuth(true);
      const currentUser = await authService.me();
      setUser(currentUser);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);
      setAuthChecked(true);
    } catch (error) {
      notifyUserError('auth_check', error, {
        title: 'Sign-in check failed',
        description: error.status === 401 || error.status === 403
          ? 'Please sign in again to use the configured backend.'
          : 'Road Sage could not verify your sign-in. Local app features can still load where available.',
      });
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      
      if (error.status === 401 || error.status === 403) {
        authService.logout();
        setAuthError({
          type: 'auth_required',
          message: 'Authentication required'
        });
      } else {
        setAuthError({
          type: 'auth_check_failed',
          message: error?.message || 'Authentication check failed',
        });
      }
    }
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    authService.logout();
    
    if (shouldRedirect) {
      window.location.assign('/');
    }
  };

  const navigateToLogin = () => {
    authService.redirectToLogin(window.location.href);
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
