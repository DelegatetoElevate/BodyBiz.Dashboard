export const config = { runtime: 'edge' };

export default async function handler(request) {
  const headers = new Headers();
  headers.append('set-cookie', 'bb_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  headers.append('set-cookie', 'bb_identity=; Path=/; Secure; SameSite=Lax; Max-Age=0');
  headers.set('location', '/login.html');
  return new Response(null, { status: 302, headers });
}
