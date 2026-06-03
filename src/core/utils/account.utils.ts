/**
 * Account Utilities
 * 
 * Helper functions for account operations, such as robust email matching.
 */

/**
 * Robustly matches two email addresses / user accounts.
 * Compares only the local parts (the username before '@') if one of them is missing a domain name.
 * 
 * Example:
 * - isEmailMatch('iarecodul53@gmail.com', 'Iarecodul53') => true
 * - isEmailMatch('iarecodul51@gmail.com', 'iarecodul51@gmail.com') => true
 * - isEmailMatch('iarecodul50@gmail.com', 'iarecodul51@gmail.com') => false
 */
export function isEmailMatch(email1: string | null | undefined, email2: string | null | undefined): boolean {
  if (!email1 || !email2) return false;
  const e1 = email1.toLowerCase().trim();
  const e2 = email2.toLowerCase().trim();
  if (e1 === e2) return true;

  const u1 = e1.includes('@') ? e1.split('@')[0] : e1;
  const u2 = e2.includes('@') ? e2.split('@')[0] : e2;
  return u1 === u2;
}
