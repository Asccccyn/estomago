// Runtime 2.1.283's early-access function hook. Match generated attachment
// types, not text patterns: user text and tool results can quote the same tags.
export function register(on) {
  on('prompt.attachment', { type: ['environment', 'model', 'date', 'date_change'] },
    (_context, input, next) => input.origin.kind === 'engine' ? { text: null } : next(input));
  // Filter the generated context block before CC snapshots it for native session replay.
  on('prompt.context', (_context, input, next) => next({
    ...input,
    blocks: input.blocks.filter(block => block.name !== 'userEmail'),
  }));
}
