const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const sessions = new Map();
let timeoutHandler = null;

function configureTimeoutHandler(fn) {
  timeoutHandler = fn;
}

function getSession(chatId) {
  return sessions.get(chatId);
}

// idle = true: session is stored WITHOUT an inactivity timer (used for the main menu,
// which is a resting state and must never "time out" and re-post itself).
function setSession(chatId, session, bot, { idle = false } = {}) {
  const existing = sessions.get(chatId);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  if (session.timer) {
    clearTimeout(session.timer);
  }

  session.timer = idle ? null : setTimeout(() => {
    // only expire this exact session, never a newer one that replaced it
    if (sessions.get(chatId) !== session) return;
    sessions.delete(chatId);
    if (timeoutHandler) {
      timeoutHandler(chatId, bot);
    }
  }, SESSION_TIMEOUT_MS);

  sessions.set(chatId, session);
}

function endSession(chatId) {
  const existing = sessions.get(chatId);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  sessions.delete(chatId);
}

module.exports = { getSession, setSession, endSession, configureTimeoutHandler };
