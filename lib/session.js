const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const sessions = new Map();
let timeoutHandler = null;

function configureTimeoutHandler(fn) {
  timeoutHandler = fn;
}

function getSession(chatId) {
  return sessions.get(chatId);
}

function setSession(chatId, session, bot) {
  const existing = sessions.get(chatId);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }

  session.timer = setTimeout(() => {
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

