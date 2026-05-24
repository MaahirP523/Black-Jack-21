const STORAGE_KEY = "aurum21.player";
const defaultPlayer = { balance: 10000, lastDailyReward: "", settings: { music: true, sfx: true, cardBack: "onyx" }, stats: { hands: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0, biggestWin: 0, chipsWon: 0, chipsLost: 0 }, achievements: [] };
export function loadPlayer() { try { return mergeDefaults(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch { return structuredClone(defaultPlayer); } }
export function savePlayer(player) { localStorage.setItem(STORAGE_KEY, JSON.stringify(player)); }
export function resetPlayer() { const fresh = structuredClone(defaultPlayer); savePlayer(fresh); return fresh; }
function mergeDefaults(saved) { if (!saved || typeof saved !== "object") return structuredClone(defaultPlayer); return { ...structuredClone(defaultPlayer), ...saved, settings: { ...defaultPlayer.settings, ...saved.settings }, stats: { ...defaultPlayer.stats, ...saved.stats }, achievements: Array.isArray(saved.achievements) ? saved.achievements : [] }; }
