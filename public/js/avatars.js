// avatars.js
// Preset icon choices shown at signup. Kept intentionally simple (emoji-based)
// so the app has zero dependency on file uploads or external image hosting.
// IDs here must match AVATAR_IDS in server.js.

const AVATARS = [
  { id: 'fox', emoji: '🦊', bg: '#c9642f' },
  { id: 'wolf', emoji: '🐺', bg: '#5b6472' },
  { id: 'bear', emoji: '🐻', bg: '#7a5233' },
  { id: 'owl', emoji: '🦉', bg: '#6b5b3e' },
  { id: 'otter', emoji: '🦦', bg: '#8a6b4a' },
  { id: 'stag', emoji: '🦌', bg: '#7a4a2e' },
  { id: 'cat', emoji: '🐱', bg: '#a85f4d' },
  { id: 'raven', emoji: '🐦', bg: '#3d3630' },
  { id: 'frog', emoji: '🐸', bg: '#5e7a4a' },
  { id: 'hawk', emoji: '🦅', bg: '#6e4a33' },
  { id: 'panda', emoji: '🐼', bg: '#403830' },
  { id: 'turtle', emoji: '🐢', bg: '#4a6e52' },
];

function avatarById(id) {
  return AVATARS.find((a) => a.id === id) || { id, emoji: '❔', bg: '#555' };
}
