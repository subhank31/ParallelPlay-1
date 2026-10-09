const { PlayerSession } = require('../player-session');

const crashes = [];
process.on('uncaughtException', (error) => crashes.push(error.stack || String(error)));
process.on('unhandledRejection', (error) => {
  crashes.push(error && error.stack ? error.stack : String(error));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const session = new PlayerSession();
  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  try {
    session.start();
    const ready = await session.send('getState');
    record('helper is ready', ready && ready.ok === true, ready && ready.error);

    const stdin = session.child.stdin;
    process.kill(session.child.pid, 'SIGKILL');
    await sleep(100);
    await new Promise((resolve) => {
      stdin.write('{"id":"closed","type":"getState"}\n', () => resolve());
    });
    await sleep(200);
    record(
      'closed pipe does not crash the app',
      crashes.length === 0,
      crashes.join(' | ')
    );

    let restarted = null;
    for (let i = 0; i < 20 && !(restarted && restarted.ok); i += 1) {
      try {
        restarted = await session.send('getState', {}, 2000);
      } catch (error) {
        await sleep(200);
      }
    }
    record(
      'helper restarts after the pipe closes',
      !!(restarted && restarted.ok),
      restarted && restarted.error
    );

    const before = crashes.length;
    if (session.child && session.child.stdout) {
      session.child.stdout.destroy(new Error('simulated pipe failure'));
    }
    await sleep(300);
    record(
      'stdout pipe error does not crash the app',
      crashes.length === before,
      crashes.slice(before).join(' | ')
    );
  } catch (error) {
    record('pipe test exception', false, error.stack || error.message);
  } finally {
    await session.shutdown();
    await sleep(100);
    const failed = results.filter((item) => !item.ok);
    if (crashes.length && !results.some((item) => item.name === 'closed pipe does not crash the app' && !item.ok)) {
      console.error(crashes.join('\n'));
    }
    console.log(`\n${results.length - failed.length}/${results.length} pipe checks passed`);
    process.exit(failed.length === 0 && crashes.length === 0 ? 0 : 1);
  }
}

main();
