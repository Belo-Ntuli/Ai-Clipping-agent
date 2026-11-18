/**
 * Mock chat lets you verify the whole pipe (runner -> dashboard -> review)
 * before any platform credentials exist. It emits ordinary chatter with a
 * hype burst every 18 seconds, so a candidate should appear within one or two
 * ticks. It is for plumbing checks only: nothing here reflects real streams.
 */
const CHATTER = [
  'yo chat',
  'this mission is taking forever',
  'the graphics look insane',
  'wait did he just drive off the bridge',
  'chat is this real',
  'first time catching this live',
  'police everywhere',
  'no way he survived that',
  'ok that was actually smooth',
  'bro the wanted level',
  'chat calm down',
  'he is not making it out',
]

const HYPE = [
  'KEKW',
  'LULW',
  'OMEGALUL',
  'LOL',
  'CLIP IT',
  'NO WAY',
  'WTF',
  'OMG',
  'KEKW',
]

const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!

export class MockChat {
  private timers = new Set<ReturnType<typeof setInterval>>()

  start(onMessage: (text: string) => void) {
    this.timers.add(
      setInterval(() => {
        onMessage(pick(CHATTER))
      }, 350),
    )
    this.timers.add(
      setInterval(() => {
        let sent = 0
        const burst = setInterval(() => {
          onMessage(pick(HYPE))
          sent += 1
          if (sent >= 90) {
            clearInterval(burst)
            this.timers.delete(burst)
          }
        }, 60)
        this.timers.add(burst)
      }, 18_000),
    )
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
  }
}
