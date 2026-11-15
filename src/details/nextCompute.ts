// The next-sunset / next-Earthset computation (step 22), shared by the details Worker and the tests. It uses the same
// visibilityModel and nextSet as the calculations: the site (with its horizon), the Earth minimum elevation and the model
// identity come from the snapshot; no terrain file is read and nothing refers to the latest terrain. Importing the public
// sim entry installs the UTC -> TT time scale, as in the mission Worker.
import '../sim/index'
import { visibilityModel } from '../sim/visibility'
import { nextSet } from '../sim/events'
import type { NextRequest } from './nextEventModel'
import type { NextSet } from '../sim/events'

export function computeNext(req: NextRequest): NextSet {
  const model = visibilityModel(req.site, { earthMinElevationDeg: req.earthMinElevationDeg, estimated: req.estimated })
  // Sunset = terrain geometry only ('sun-terrain'): an eclipse start is not a sunset.
  return req.target === 'sunset'
    ? nextSet(model, { target: 'sun', channel: 'sun-terrain', queryMs: req.queryMs, searchMs: req.searchMs })
    : nextSet(model, { target: 'earth', queryMs: req.queryMs, searchMs: req.searchMs })
}
