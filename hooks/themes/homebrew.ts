import type { Skin } from '../skin'

// brew.sh: cream text and gold links on its dark brown, the logo's beer amber for the accent,
// and the site's code colours for the kinds. On a light background, the brown is the ink.
const skin: Skin = {
  name: 'homebrew',
  label: 'Homebrew',
  palette: {
    read: '#87c7d8',
    write: '#f7c96c',
    run: '#52baba',
    search: '#afaf5e',
    web: '#9aadeb',
    mcp: '#cd9ccd',
    other: '#d1d3d4',
    user: '#fbb040',
    fg: '#ffd79a',
    muted: '#c2a882',
    surface: '#433f3a',
    zebra: '#3a3731',
    ok: '#8db76c',
    err: '#ff8a7a',
    warn: '#e2a843',
  },
  light: {
    read: '#2a768b',
    write: '#88673c',
    run: '#007a7a',
    search: '#717100',
    web: '#445588',
    mcp: '#800080',
    other: '#555555',
    user: '#97600b',
    fg: '#2e2a24',
    muted: '#7c6b4e',
    surface: '#fbefd9',
    zebra: '#fdf7ec',
    ok: '#427b25',
    err: '#aa0000',
    warn: '#9c5f09',
  },
  spinner: ['Brewing', 'Tapping', 'Pouring', 'Fermenting', 'Bottling', 'Cellaring'],
  done: ['Brewed', 'Poured', 'Bottled', 'Tapped'],
}

export default skin
