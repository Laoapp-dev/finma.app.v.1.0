import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../supabase";
import { useAuth } from "../context/AuthContext";
import { useCurrency } from "../context/CurrencyContext";
import { monthKey } from "../utils/dateUtils";

/**
 * Postgres layout (see supabase/migrations/0001_init.sql for the matching
 * Row Level Security policies):
 *   ledger_entries(id, user_id, date, type, category, description, amount,
 *                   currency, cycle_key)  -> one row per transaction
 *   monthly_cycles(user_id, cycle_key, opening_balance, closed,
 *                   closing_balance)      -> PK (user_id, cycle_key)
 *
 * We fetch the whole ledger_entries table for this user once, then patch
 * it in place from Realtime postgres_changes events — cheap enough for a
 * personal ledger's data volume, and it means the UI never has to
 * re-fetch just to reflect a change it already knows about locally.
 */

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Convert a ledger_entries row (snake_case, as Postgres returns it) into
// the camelCase shape the rest of the app already expects.
function fromRow(row) {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    category: row.category,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    cycleKey: row.cycle_key,
  };
}

export function useLedger() {
  const { user } = useAuth();
  const { convert, currency: primaryCurrency } = useCurrency();

  const currentKey = monthKey();
  const [transactions, setTransactions] = useState([]);
  const [currentCycle, setCurrentCycle] = useState({ openingBalance: 0, closed: false });
  const [rolloverNotice, setRolloverNotice] = useState(null);
  const [loadingLedger, setLoadingLedger] = useState(Boolean(user));
  // Surfaced to the UI (Financial/Dashboard/Analytics) so a failed read or
  // write is visible instead of silently doing nothing — a rejected
  // Supabase call (RLS denial, offline, bad policy, etc.) would otherwise
  // fail silently, and the entry would never actually reach the database,
  // so it could never show up on Dashboard/Analytics either.
  const [ledgerError, setLedgerError] = useState(null);

  const netForCycle = useCallback(
    (cycleKey, txList) =>
      txList
        .filter((tx) => tx.cycleKey === cycleKey)
        .reduce((sum, tx) => {
          const amt = convert(Number(tx.amount) || 0, tx.currency, primaryCurrency);
          return sum + (tx.type === "income" ? amt : -amt);
        }, 0),
    [convert, primaryCurrency]
  );

  // ---------------------------------------------------------------------
  // Signed OUT: an empty, read-only ledger. AuthGate shows the "sign in
  // to save your data" prompt on top of it — there's no fake/demo content.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (user) return;
    setTransactions([]);
    setCurrentCycle({ openingBalance: 0, closed: false });
    setLoadingLedger(false);
  }, [user, currentKey]);

  // ---------------------------------------------------------------------
  // Signed IN: initial fetch + Realtime subscription for ledger_entries.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!user) return;
    setLoadingLedger(true);
    setLedgerError(null);

    let cancelled = false;

    supabase
      .from("ledger_entries")
      .select("*")
      .eq("user_id", user.id)
      .order("date", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Ledger fetch failed:", error);
          setLedgerError(error.message || String(error));
        } else {
          setTransactions(data.map(fromRow));
        }
        setLoadingLedger(false);
      });

    // Realtime: keeps `transactions` in sync with inserts/updates/deletes
    // from any device/tab, the Supabase equivalent of Firestore's
    // onSnapshot. Requires ledger_entries to be added to the
    // supabase_realtime publication (already done in the migration).
    const channel = supabase
      .channel(`ledger_entries:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ledger_entries", filter: `user_id=eq.${user.id}` },
        (payload) => {
          setTransactions((prev) => {
            if (payload.eventType === "INSERT") {
              if (prev.some((tx) => tx.id === payload.new.id)) return prev; // already added optimistically
              return [fromRow(payload.new), ...prev];
            }
            if (payload.eventType === "UPDATE") {
              return prev.map((tx) => (tx.id === payload.new.id ? fromRow(payload.new) : tx));
            }
            if (payload.eventType === "DELETE") {
              return prev.filter((tx) => tx.id !== payload.old.id);
            }
            return prev;
          });
        }
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          setLedgerError(
            "Realtime sync unavailable — check that ledger_entries is enabled for Realtime in Supabase."
          );
        }
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user]);

  // ---------------------------------------------------------------------
  // Monthly roll-over engine.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!user) return;

    async function runRollover() {
      const { data: currentRow, error: currentErr } = await supabase
        .from("monthly_cycles")
        .select("*")
        .eq("user_id", user.id)
        .eq("cycle_key", currentKey)
        .maybeSingle();
      if (currentErr) throw currentErr;

      if (currentRow) {
        setCurrentCycle({
          openingBalance: currentRow.opening_balance,
          closed: currentRow.closed,
          closingBalance: currentRow.closing_balance,
        });
        return;
      }

      // Current month's cycle row doesn't exist yet — close any still-open
      // prior cycles and carry the balance forward.
      const { data: openRows, error: openErr } = await supabase
        .from("monthly_cycles")
        .select("*")
        .eq("user_id", user.id)
        .eq("closed", false);
      if (openErr) throw openErr;

      if (!openRows || openRows.length === 0) {
        // First time this user has ever opened the ledger.
        const fresh = { openingBalance: 0, closed: false };
        const { error } = await supabase
          .from("monthly_cycles")
          .upsert({ user_id: user.id, cycle_key: currentKey, opening_balance: 0, closed: false });
        if (error) throw error;
        setCurrentCycle(fresh);
        return;
      }

      const { data: allEntryRows, error: allErr } = await supabase
        .from("ledger_entries")
        .select("*")
        .eq("user_id", user.id);
      if (allErr) throw allErr;
      const allEntries = allEntryRows.map(fromRow);

      let carryBalance = 0;
      let lastClosedKey = null;

      // Sort so cycles close in chronological order if more than one was
      // somehow left open (e.g. the app wasn't opened for several months).
      const openSorted = [...openRows].sort((a, b) => (a.cycle_key < b.cycle_key ? -1 : 1));

      for (const cycleRow of openSorted) {
        const key = cycleRow.cycle_key;
        const net = netForCycle(key, allEntries);
        const closingBalance = round2((cycleRow.opening_balance || 0) + net);
        const { error } = await supabase
          .from("monthly_cycles")
          .update({ closed: true, closing_balance: closingBalance })
          .eq("user_id", user.id)
          .eq("cycle_key", key);
        if (error) throw error;
        carryBalance = closingBalance;
        lastClosedKey = key;
      }

      const newCycle = { openingBalance: carryBalance, closed: false };
      const { error: insertErr } = await supabase
        .from("monthly_cycles")
        .upsert({ user_id: user.id, cycle_key: currentKey, opening_balance: carryBalance, closed: false });
      if (insertErr) throw insertErr;
      setCurrentCycle(newCycle);

      if (lastClosedKey) {
        setRolloverNotice({ amount: carryBalance, fromKey: lastClosedKey });
      }
    }

    runRollover().catch((err) => {
      console.error("Roll-over failed:", err);
      setLedgerError(err.message || String(err));
    });
  }, [user, currentKey, netForCycle]);

  const currentTransactions = useMemo(
    () =>
      transactions
        .filter((tx) => tx.cycleKey === currentKey)
        .sort((a, b) => new Date(b.date) - new Date(a.date)),
    [transactions, currentKey]
  );

  const currentBalance = round2((currentCycle.openingBalance || 0) + netForCycle(currentKey, transactions));

  const addTransaction = useCallback(
    async (tx) => {
      if (!user) return false; // AuthGate prevents this UI path anyway
      try {
        setLedgerError(null);
        const { data, error } = await supabase
          .from("ledger_entries")
          .insert({
            user_id: user.id,
            date: tx.date,
            type: tx.type,
            category: tx.category,
            description: tx.description,
            amount: tx.amount,
            currency: tx.currency,
            cycle_key: monthKey(new Date(tx.date)),
          })
          .select()
          .single();
        if (error) throw error;
        // Add it locally right away rather than waiting on the Realtime
        // round-trip, so the UI updates instantly.
        setTransactions((prev) => [fromRow(data), ...prev]);
        return true;
      } catch (err) {
        // This used to be unhandled: a rejected write (RLS denial,
        // offline, bad policy, etc.) would vanish silently and the caller
        // had no way to know the entry never saved.
        console.error("Failed to add transaction:", err);
        setLedgerError(err.message || String(err));
        return false;
      }
    },
    [user]
  );

  const deleteTransaction = useCallback(
    async (id) => {
      if (!user) return false;
      try {
        setLedgerError(null);
        const { error } = await supabase.from("ledger_entries").delete().eq("id", id).eq("user_id", user.id);
        if (error) throw error;
        setTransactions((prev) => prev.filter((tx) => tx.id !== id));
        return true;
      } catch (err) {
        console.error("Failed to delete transaction:", err);
        setLedgerError(err.message || String(err));
        return false;
      }
    },
    [user]
  );

  return {
    currentCycleKey: currentKey,
    currentCycle,
    currentTransactions,
    currentBalance,
    addTransaction,
    deleteTransaction,
    rolloverNotice,
    clearRolloverNotice: () => setRolloverNotice(null),
    loadingLedger,
    ledgerError,
    clearLedgerError: () => setLedgerError(null),
    isDemo: !user,
  };
}
