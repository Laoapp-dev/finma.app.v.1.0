import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { supabase, isSupabaseConfigured } from "../supabase";
import { isAdminEmail } from "../config/admin";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured) return; // App.jsx shows a config-error screen instead

    // Safety net: on a slow or flaky mobile connection, the profile
    // fetch/insert below can hang or fail silently, which would otherwise
    // leave `loading` stuck at `true` forever — the Sign In button would
    // show its loading skeleton indefinitely instead of ever appearing.
    // Force it to resolve after 6s regardless, so the button always shows
    // up (tapping it will surface any real underlying error).
    const safetyTimer = setTimeout(() => setLoading(false), 6000);

    async function loadProfile(authUser) {
      try {
        const { data: existing, error: selectErr } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", authUser.id)
          .maybeSingle();

        if (selectErr) throw selectErr;

        if (existing) {
          setProfile(existing);
        } else {
          const newProfile = {
            id: authUser.id,
            name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || "",
            email: authUser.email || "",
            photo_url: authUser.user_metadata?.avatar_url || "",
            primary_currency: "LAK",
            language: "en",
          };
          const { error: insertErr } = await supabase.from("profiles").insert(newProfile);
          if (insertErr) throw insertErr;
          setProfile(newProfile);
        }
      } catch (err) {
        // Network hiccup fetching/creating the profile row shouldn't block
        // the UI from ever showing — the user is still signed in either way.
        console.error("Failed to load/create profile:", err);
      } finally {
        clearTimeout(safetyTimer);
        setLoading(false);
      }
    }

    // Fires once immediately with whatever session exists (or null), and
    // again on every future sign-in/sign-out/token refresh — this is the
    // Supabase equivalent of Firebase's onAuthStateChanged.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const authUser = session?.user ?? null;
      setUser(authUser);
      if (authUser) {
        loadProfile(authUser);
      } else {
        setProfile(null);
        clearTimeout(safetyTimer);
        setLoading(false);
      }
    });

    return () => {
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!isSupabaseConfigured) {
      // Buttons that trigger this are hidden/disabled when unconfigured
      // (see Topbar.jsx, AuthGate.jsx) — this is just a safety net so a
      // stray call never throws "supabase is undefined" at runtime.
      console.warn("Sign-in unavailable: Supabase isn't configured.");
      return;
    }
    // Supabase OAuth always redirects (there's no popup-based flow like
    // Firebase's signInWithPopup) — the browser navigates to Google and
    // back to `redirectTo` once signed in. This also sidesteps the old
    // popup-blocked-in-in-app-browsers problem (Facebook/Messenger/
    // Instagram/LINE's built-in browsers) entirely, since there's no
    // popup to block in the first place.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    await supabase.auth.signOut();
  }, []);

  const updateProfile = useCallback(
    async (partial) => {
      if (!isSupabaseConfigured || !user) return;
      const { error } = await supabase.from("profiles").update(partial).eq("id", user.id);
      if (error) throw error;
      setProfile((prev) => ({ ...prev, ...partial }));
    },
    [user]
  );

  const isAdmin = isAdminEmail(user?.email);

  const value = useMemo(
    () => ({
      user,
      profile,
      isAdmin,
      loading,
      signInWithGoogle,
      signOut,
      updateProfile,
      isSupabaseConfigured,
    }),
    [user, profile, isAdmin, loading, signInWithGoogle, signOut, updateProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
