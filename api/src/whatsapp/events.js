/**
 * Live updates for the WhatsApp Inbox: server-sent events.
 *
 * One open connection per signed-in staff browser (GET /api/whatsapp/inbox/stream). When anything in the inbox changes - a reply
 * arrives, a message is sent, a delivery receipt moves a tick, a conversation is read or reassigned - `publish` tells every connection
 * THAT SOMETHING CHANGED, naming the conversation and number but carrying no message text. The page then asks the API for what it needs, and
 * the API answers per person (row-level security decides which conversations they may see), so an event can never leak a message to somebody
 * who may not read it. It is in-process, which is right for this server (one process); a second server would need a shared channel here.
 *
 * Without it the page still works: it falls back to asking every 15 seconds.
 */
const clients = new Set();
let beat = null;

export function subscribe(req, res) {
  res.status(200).set({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 4000\n: connected\n\n');
  const client = { res, userId: req.session && req.session.userId };
  clients.add(client);
  if (!beat) {
    beat = setInterval(() => { for (const c of clients) { try { c.res.write(': keep-alive\n\n'); } catch { clients.delete(c); } } }, 25000);
    beat.unref();
  }
  req.on('close', () => { clients.delete(client); if (!clients.size && beat) { clearInterval(beat); beat = null; } });
}

/** Tell every open inbox that something changed. `evt` = { type, conversationId?, numberId? } - never message text. */
export function publish(evt) {
  const data = `event: inbox\ndata: ${JSON.stringify({ type: evt.type, conversationId: evt.conversationId || null, numberId: evt.numberId || null, at: Date.now() })}\n\n`;
  for (const c of clients) { try { c.res.write(data); } catch { clients.delete(c); } }
}

export const openConnections = () => clients.size;
