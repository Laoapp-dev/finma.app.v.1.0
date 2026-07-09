// Client-side admin check, used to show/hide the Admin nav item and page.
// This is a UX convenience only — it is NOT what actually protects admin
// data. Real enforcement lives in `supabase/migrations/0001_init.sql`,
// whose RLS policies check the same email via `auth.jwt() ->> 'email'`
// (the verified Google sign-in claim) before allowing any admin read/write.
// Add more admins by adding emails to both this list and the matching
// policies in that migration file.
export const ADMIN_EMAILS = ["berndvh015@gmail.com"];

export function isAdminEmail(email) {
  return Boolean(email) && ADMIN_EMAILS.includes(email.toLowerCase());
}
