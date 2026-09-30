// SPDX-License-Identifier: Apache-2.0
// Agentprof's mark: an agent face with a performance trace across its display.
export const AGENTPROF_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
  <defs><linearGradient id="body" x2="1" y2="1"><stop stop-color="#3979e8"/><stop offset="1" stop-color="#7259c9"/></linearGradient></defs>
  <path d="M40 17V10" fill="none" stroke="#3979e8" stroke-width="4" stroke-linecap="round"/>
  <circle cx="40" cy="8" r="5" fill="#18a389"/>
  <rect x="10" y="18" width="60" height="52" rx="15" fill="url(#body)"/>
  <path d="M5 37v14m70-14v14" stroke="#3979e8" stroke-width="6" stroke-linecap="round"/>
  <rect x="18" y="26" width="44" height="35" rx="9" fill="#17243d"/>
  <circle cx="30" cy="36" r="3" fill="#fff"/><circle cx="50" cy="36" r="3" fill="#fff"/>
  <path d="M23 51h8l5-9 7 15 6-10h8" fill="none" stroke="#58e3bc" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M31 69v5m18-5v5" stroke="#7259c9" stroke-width="5" stroke-linecap="round"/>
</svg>`;
export const AGENTPROF_ICON = `data:image/svg+xml,${encodeURIComponent(AGENTPROF_ICON_SVG)}`;
