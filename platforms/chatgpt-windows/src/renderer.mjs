import { setTimeout as delay } from 'node:timers/promises';
import { CdpClient, evaluate } from './cdp.mjs';

export const readinessExpression = `(() => ({
  ready:document.readyState,body:!!document.body,width:innerWidth,height:innerHeight,protocol:location.protocol,
  visibleControls:[...document.querySelectorAll('button,[role="button"],input,textarea')].filter(element=>{
    const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
    return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';
  }).length
}))()`;

export async function connectRenderer(session, { signal, worldName, targetId }) {
  const client = await CdpClient.connect(session.browserUrl);
  const pause = ms => delay(ms, undefined, { signal });
  try {
    const deadline = Date.now() + 60_000;
    let startupReconnects = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const { targetInfos } = await client.send('Target.getTargets');
      const candidates = targetInfos.filter(info => info.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(info.url) && (!targetId || info.targetId === targetId));
      if (candidates.length !== 1) { await pause(250); continue; }
      const target = candidates[0];
      let sessionId;
      try {
        ({ sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
        const { frameTree } = await client.send('Page.getFrameTree', {}, { sessionId });
        const { executionContextId } = await client.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName }, { sessionId });
        const evaluateScript = expression => evaluate(client, sessionId, expression, executionContextId);
        while (Date.now() < deadline) {
          const ready = await evaluateScript(readinessExpression);
          if (ready?.body && ready.protocol === 'app:' && ready.ready === 'complete' && ready.visibleControls > 0) {
            return { client, sessionId, contextId: executionContextId, evaluate: evaluateScript, ready, startupReconnects, targetUrl: target.url.split(/[?#]/)[0] };
          }
          await pause(300);
        }
      } catch (error) {
        if (!/Session with given id not found|context|closed|target|frame|timed out/i.test(error.message)) throw error;
        startupReconnects++;
        if (sessionId) await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        await pause(250);
      }
    }
    throw new Error('The app renderer did not stabilize within 60 seconds.');
  } catch (error) {
    client.close();
    throw error;
  }
}
