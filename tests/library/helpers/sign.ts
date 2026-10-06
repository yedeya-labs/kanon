/**
 * Sign a fixture post the way the lanes sign theirs (plan 0005 §3.3): a post by an agent App's
 * login opens with that role's persona header and marker, which every reader of §3.3's table
 * requires beside the login since L4. The fixture adopter's register gives each role its own
 * slug, so the login names the role; a login that is no agent's (a person) is left unsigned.
 */
const { loadAppRegister } = await import('../../../scripts/app-register.mjs');
const { MARKED_ROLES, signed, slugOf } = await import('../../../scripts/lib/role-marker.mjs');

/** The agent role whose slug `login` is, in the fixture register, or null. */
export function roleOf(login: unknown): string | null {
  const slug = slugOf(login);
  for (const [role, s] of loadAppRegister() as Map<string, string>) {
    if (s === slug && (MARKED_ROLES as readonly string[]).includes(role)) return role;
  }
  return null;
}

/** `body`, signed as the role `login` plays, or unchanged when `login` is no agent's. */
export function asAgent(login: unknown, body: string): string {
  const role = roleOf(login);
  return role ? signed(body, role) : body;
}
