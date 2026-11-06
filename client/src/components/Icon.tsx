import type { IconName } from '../data/types'

// 9x9 pixel icons from the design. The sprite is rendered once in the app shell.
const PATHS: Record<IconName, string> = {
  check: 'M7 1h1v1H7zM6 2h2v1H6zM1 3h1v1H1zM5 3h2v1H5zM1 4h2v1H1zM4 4h2v1H4zM2 5h3v1H2zM3 6h1v1H3z',
  cross: 'M1 1h2v1H1zM6 1h2v1H6zM2 2h2v1H2zM5 2h2v1H5zM3 3h3v1H3zM4 4h1v1H4zM3 5h3v1H3zM2 6h2v1H2zM5 6h2v1H5zM1 7h2v1H1zM6 7h2v1H6z',
  lock: 'M3 1h3v1H3zM2 2h1v2H2zM6 2h1v2H6zM1 4h7v1H1zM1 5h3v2H1zM5 5h3v2H5zM1 7h7v1H1z',
  clock: 'M3 1h3v1H3zM2 2h1v1H2zM6 2h1v1H6zM1 3h1v3H1zM7 3h1v3H7zM4 3h1v2H4zM5 4h1v1H5zM2 6h1v1H2zM6 6h1v1H6zM3 7h3v1H3z',
  bang: 'M3 1h3v4H3zM3 6h3v2H3z',
  arrow: 'M1 4h6v1H1zM5 2h1v1H5zM6 3h1v1H6zM7 4h1v1H7zM6 5h1v1H6zM5 6h1v1H5z',
  back: 'M2 4h6v1H2zM3 2h1v1H3zM2 3h1v1H2zM1 4h1v1H1zM2 5h1v1H2zM3 6h1v1H3z',
  hex: 'M4 0h1v1H4zM2 1h2v1H2zM5 1h2v1H5zM1 2h1v5H1zM7 2h1v5H7zM2 7h2v1H2zM5 7h2v1H5zM4 8h1v1H4z',
  gear: 'M3 1h1v1H3zM5 1h1v1H5zM2 2h5v1H2zM1 3h2v1H1zM6 3h2v1H6zM2 4h1v1H2zM6 4h1v1H6zM1 5h2v1H1zM6 5h2v1H6zM2 6h5v1H2zM3 7h1v1H3zM5 7h1v1H5z',
  person: 'M3 1h3v3H3zM2 5h5v1H2zM1 6h7v2H1z',
  play: 'M2 1h1v7H2zM3 2h1v5H3zM4 3h1v3H4zM5 4h1v1H5z',
  coin: 'M3 1h3v1H3zM2 2h1v1H2zM6 2h1v1H6zM1 3h1v3H1zM7 3h1v3H7zM4 3h1v3H4zM2 6h1v1H2zM6 6h1v1H6zM3 7h3v1H3z',
  replay: 'M3 1h4v1H3zM2 2h1v1H2zM7 2h1v3H7zM1 3h1v3H1zM6 4h3v1H6zM2 6h1v1H2zM3 7h4v1H3z',
  b: 'M2 1h4v1H2zM2 2h1v5H2zM6 2h1v2H6zM2 4h4v1H2zM6 5h1v2H6zM2 7h4v1H2z',
  shield: 'M1 1h7v1H1zM1 2h1v3H1zM7 2h1v3H7zM2 5h1v1H2zM6 5h1v1H6zM3 6h1v1H3zM5 6h1v1H5zM4 7h1v1H4zM3 3h1v1H3zM4 4h1v1H4zM5 3h1v1H5z',
  plus: 'M4 1h1v7H4zM1 4h7v1H1z',
}

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      {(Object.keys(PATHS) as IconName[]).map((k) => (
        <symbol key={k} id={`i-${k}`} viewBox="0 0 9 9">
          <path d={PATHS[k]} />
        </symbol>
      ))}
    </svg>
  )
}

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="px" aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  )
}

export function Logo() {
  return (
    <svg width="30" height="20" viewBox="0 0 29 19" aria-hidden="true">
      <rect x="10" y="0" width="9" height="9" fill="#FFE6D0" />
      <rect x="20" y="0" width="9" height="9" fill="#FF5A00" />
      <rect x="0" y="10" width="9" height="9" fill="#007BFF" />
      <rect x="10" y="10" width="9" height="9" fill="#FFE6D0" />
    </svg>
  )
}
