import type { EventSource } from "./types"
import { nycParksSource } from "./nyc-parks"
import { summerStageSource } from "./summerstage"
import { prospectParkSource } from "./prospect-park"
import { greenWoodSource } from "./green-wood"
import { theSkintSource } from "./theskint"
import { thoughtGallerySource } from "./thought-gallery"
import { pulsdSource } from "./pulsd"
import { brooklynBridgeParkSource } from "./brooklyn-bridge-park"
import { hudsonRiverParkSource } from "./hudson-river-park"
import { rooftopFilmsSource } from "./rooftop-films"
import { rooftopCinemaClubSource } from "./rooftop-cinema-club"
import { bryantParkSource } from "./bryant-park"
import { centralParkSource } from "./central-park"
import { nycMarqueeSource } from "./nyc-marquee"
import { nycForFreeSource } from "./nyc-for-free"
import { governorsIslandSource } from "./governors-island"
import { nyplSource } from "./nypl"
import { posterHouseSource } from "./poster-house"
import { flatironNomadSource } from "./flatiron-nomad"
import { downtownNySource } from "./downtown-ny"
import { unionSquareSource } from "./union-square"
import { hudsonYardsSource } from "./hudson-yards"

// Registry of all event sources the ingest job pulls from.
// To add a new free feed or official API later (e.g. Luma, Meetup), implement the
// EventSource interface in its own file and add it to this array. Sites running
// "The Events Calendar" (Tribe) plugin can reuse createTribeSource (see summerstage.ts).
export const eventSources: EventSource[] = [
  nycParksSource,
  summerStageSource,
  prospectParkSource,
  greenWoodSource,
  theSkintSource,
  thoughtGallerySource,
  pulsdSource,
  brooklynBridgeParkSource,
  hudsonRiverParkSource,
  rooftopFilmsSource,
  rooftopCinemaClubSource,
  bryantParkSource,
  centralParkSource,
  nycMarqueeSource,
  nycForFreeSource,
  governorsIslandSource,
  nyplSource,
  posterHouseSource,
  flatironNomadSource,
  downtownNySource,
  unionSquareSource,
  hudsonYardsSource,
]

export type { EventSource, NormalizedEvent } from "./types"
