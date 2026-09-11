/** The same duel decision is used by the server and the local bot match. */
export function numericDuel(attacker: number | null, defender: number | null, answer: number) {
  const a = attacker !== null && Number.isFinite(attacker) ? Math.abs(attacker - answer) : Infinity
  const d = defender !== null && Number.isFinite(defender) ? Math.abs(defender - answer) : Infinity
  return {
    // Equal answers are a tie at any distance. Keep the same territory and
    // ask another numeric question until one player is closer.
    replay: a === d,
    winner: a < d ? 'attacker' as const : d < a ? 'defender' as const : null,
    attackerExact: a === 0,
    defenderExact: d === 0,
  }
}
