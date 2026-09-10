/** The same duel decision is used by the server and the local bot match. */
export function numericDuel(attacker: number | null, defender: number | null, answer: number) {
  const a = attacker !== null && Number.isFinite(attacker) ? Math.abs(attacker - answer) : Infinity
  const d = defender !== null && Number.isFinite(defender) ? Math.abs(defender - answer) : Infinity
  return {
    replay: a === 0 && d === 0,
    winner: a < d ? 'attacker' as const : d < a ? 'defender' as const : null,
    attackerExact: a === 0,
    defenderExact: d === 0,
  }
}
