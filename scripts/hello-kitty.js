const pink = process.stdout.hasColors && process.stdout.hasColors() ? '\x1b[95m' : '';
const reset = pink ? '\x1b[0m' : '';

console.log(pink + [
  '       /\\_/\\  /\\_/\\       ',
  '      ( o   o )          ',
  '      =( ^ )=            ',
  '    /|  ---  |\\          ',
  '   / | (___) | \\         ',
  '  /  |_______|  \\        ',
  '       |   |             ',
  '      /|   |\\            ',
  '                          ',
  '    Hello Kitty!          ',
].join('\n') + reset);
