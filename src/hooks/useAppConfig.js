import { useCallback, useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "../supabase";
import { useAuth } from "../context/AuthContext";

const CONFIG_KEY = "global";

export function useAppConfig() {
  const [config, setConfig] = useState({ maintenanceMode: false });
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const { isAdmin, user } = useAuth();

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    supabase
      .from("app_config")
      .select("*")
      .eq("key", CONFIG_KEY)
      .maybeSingle()
      .then(({ data }) => {
        setConfig(data ? { maintenanceMode: data.maintenance_mode } : { maintenanceMode: false });
        setLoading(false);
      })
      .catch(() => setLoading(false)); // e.g. offline — fail open rather than blocking the app

    const channel = supabase
      .channel("app_config:global")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_config", filter: `key=eq.${CONFIG_KEY}` },
        (payload) => {
          if (payload.new) setConfig({ maintenanceMode: payload.new.maintenance_mode });
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  const setMaintenanceMode = useCallback(
    async (maintenanceMode) => {
      if (!isAdmin) return; // RLS would reject this anyway; guard client-side too
      const { error } = await supabase.from("app_config").upsert({
        key: CONFIG_KEY,
        maintenance_mode: maintenanceMode,
        updated_at: new Date().toISOString(),
        updated_by: user?.email || null,
      });
      if (error) throw error;
      setConfig({ maintenanceMode });
    },
    [isAdmin, user]
  );

  return { ...config, loading, setMaintenanceMode };
}
