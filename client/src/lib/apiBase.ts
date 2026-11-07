// Where the backend lives.
// - Local dev: leave VITE_API_BASE unset. Calls go to /api on this origin and Vite proxies them to the backend
//   (VITE_API_PROXY, default the Railway backend), so the login cookie is same-origin and just works.
// - Deployed frontend: set VITE_API_BASE=https://settld-backend-production.up.railway.app at build time.
//   Calls then go cross-site with cookies; Railway must have FRONTEND_ORIGIN=<this frontend's URL>.
export const API = `${(import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''}/api`
