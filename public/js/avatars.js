// avatars.js
// Status options chosen from the main page (not at signup). Kept
// intentionally simple (emoji-based) so the app has zero dependency on
// file uploads or external image hosting. IDs here must match AVATAR_IDS
// in server.js.

const AVATARS = [
  { id: 'boba_junky', label: 'Boba Junky', emoji: '😈', bg: '#9b0cb8' },
  { id: 'horny', label: 'Horny', emoji: '🤤', bg: '#eab308' },
  { id: 'rodent', label: 'Rodent', emoji: '🐿️', bg: '#9d5b10' },
  { id: 'gnome', label: 'Gnome', emoji: '🧙🏽', bg: '#3a9d10' },
  { id: 'john_blue', label: 'John Blue', emoji: '👨🏻‍🎤', bg: '#0786d5' },
];

function avatarById(id) {
  return AVATARS.find((a) => a.id === id) || { id, emoji: '❔', bg: '#555' };
}