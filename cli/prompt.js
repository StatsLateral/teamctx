import readline from 'readline';

export function ask(question, defaultValue = '') {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, answer => { rl.close(); resolve(answer.trim() || defaultValue); });
  });
}

export function askChoice(question, choices, defaultIndex = 0) {
  const list = choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}\n${list}\nChoice [${defaultIndex + 1}]: `, answer => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      resolve(Number.isFinite(idx) && idx >= 0 && idx < choices.length ? idx : defaultIndex);
    });
  });
}
