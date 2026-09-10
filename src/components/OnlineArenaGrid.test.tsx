import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OnlineArenaGrid } from './OnlineArenaGrid'
import type { MultiplayerGameState } from '../../shared/multiplayer'

it('sets each occupied polygon to its owner color directly', () => {
  const colors = ['#b55239', '#6f8d32', '#58758f']
  const state = {
    players: colors.map((color,i) => ({id:String(i),name:`Player ${i}`,color})),
    arena: colors.map((_,i) => ({row:0,col:i-1,ownerId:String(i)})),
    availableHexes: [], activePlayerId:null, phase:'expansion-between',
  } as unknown as MultiplayerGameState
  const markup = renderToStaticMarkup(<OnlineArenaGrid state={state} viewerPlayerId="0" onChoose={() => {}} />)
  const polygons = markup.match(/<polygon[^>]+>/g)!
  expect(polygons).toHaveLength(3)
  colors.forEach((color,i) => expect(polygons[i]).toContain(`style="fill:${color};`))
})
