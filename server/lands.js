// Where each ride is, a short name for lists, and whether it is a coaster.
// ThemeParks.wiki has none of these, so they are kept by hand here, matched
// on the ride's name (which the feed keeps stable) rather than its id.
//
// A pattern matches when it appears in the ride's name with case and
// punctuation ignored; the first match in a park's list wins. A ride with no
// match simply has no land, its own name, and no coaster flag.

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

// [pattern, land, short name or null, coaster]
const MK = [
  ['walt disney world railroad main street', 'Main Street, U.S.A.', 'Railroad, Main Street'],
  ['walt disney world railroad fantasyland', 'Fantasyland', 'Railroad, Fantasyland'],
  ['walt disney world railroad frontierland', 'Frontierland', 'Railroad, Frontierland'],
  ['main street vehicles', 'Main Street, U.S.A.'],
  ['jungle cruise', 'Adventureland'],
  ['pirates of the caribbean', 'Adventureland'],
  ['magic carpets of aladdin', 'Adventureland', 'Magic Carpets'],
  ['enchanted tiki room', 'Adventureland', 'Enchanted Tiki Room'],
  ['swiss family treehouse', 'Adventureland'],
  ['a pirates adventure', 'Adventureland', "A Pirate's Adventure"],
  ['big thunder mountain', 'Frontierland', 'Big Thunder Mountain', true],
  ['tianas bayou adventure', 'Frontierland', "Tiana's Bayou Adventure"],
  ['country bear', 'Frontierland', 'Country Bears'],
  ['tom sawyer island', 'Frontierland'],
  ['haunted mansion', 'Liberty Square'],
  ['hall of presidents', 'Liberty Square'],
  ['liberty square riverboat', 'Liberty Square', 'Riverboat'],
  ['seven dwarfs mine train', 'Fantasyland', null, true],
  ['peter pans flight', 'Fantasyland'],
  ['its a small world', 'Fantasyland', "it's a small world"],
  ['winnie the pooh', 'Fantasyland', 'Winnie the Pooh'],
  ['under the sea', 'Fantasyland', 'Under the Sea'],
  ['mad tea party', 'Fantasyland'],
  ['dumbo', 'Fantasyland', 'Dumbo'],
  ['barnstormer', 'Fantasyland', 'The Barnstormer', true],
  ['prince charming regal carrousel', 'Fantasyland', 'Carrousel'],
  ['philharmagic', 'Fantasyland'],
  ['enchanted tales with belle', 'Fantasyland'],
  ['casey jr', 'Fantasyland'],
  ['space mountain', 'Tomorrowland', 'Space Mountain', true],
  ['tron lightcycle', 'Tomorrowland', 'TRON', true],
  ['buzz lightyear', 'Tomorrowland', 'Buzz Lightyear'],
  ['astro orbiter', 'Tomorrowland'],
  ['tomorrowland speedway', 'Tomorrowland', 'Speedway'],
  ['peoplemover', 'Tomorrowland', 'PeopleMover'],
  ['carousel of progress', 'Tomorrowland', 'Carousel of Progress'],
  ['laugh floor', 'Tomorrowland', 'Laugh Floor'],
];

const EPCOT = [
  ['spaceship earth', 'World Celebration'],
  ['guardians of the galaxy', 'World Discovery', 'Cosmic Rewind', true],
  ['test track', 'World Discovery', null, true],
  ['mission space', 'World Discovery', 'Mission: SPACE'],
  ['soarin', 'World Nature', "Soarin'"],
  ['living with the land', 'World Nature'],
  ['seas with nemo', 'World Nature', 'The Seas with Nemo'],
  ['turtle talk', 'World Nature', 'Turtle Talk'],
  ['journey of water', 'World Nature', 'Journey of Water'],
  ['awesome planet', 'World Nature'],
  ['journey into imagination', 'World Nature', 'Imagination with Figment'],
  ['frozen ever after', 'World Showcase'],
  ['gran fiesta tour', 'World Showcase', 'Gran Fiesta Tour'],
  ['ratatouille', 'World Showcase', "Remy's Ratatouille"],
  ['reflections of china', 'World Showcase'],
  ['impressions de france', 'World Showcase'],
  ['canada far and wide', 'World Showcase', 'Canada Far and Wide'],
  ['american adventure', 'World Showcase'],
  ['beauty and the beast', 'World Showcase', 'Beauty and the Beast Sing-Along'],
];

const HS = [
  ['runaway railway', 'Hollywood Boulevard', 'Runaway Railway'],
  ['tower of terror', 'Sunset Boulevard', 'Tower of Terror'],
  ['rock n roller coaster', 'Sunset Boulevard', "Rock 'n' Roller Coaster", true],
  ['star tours', 'Echo Lake', 'Star Tours'],
  ['indiana jones', 'Echo Lake', 'Indiana Jones Stunt Show'],
  ['frozen sing', 'Echo Lake', 'Frozen Sing-Along'],
  ['rise of the resistance', "Galaxy's Edge", 'Rise of the Resistance'],
  ['smugglers run', "Galaxy's Edge", 'Smugglers Run'],
  ['slinky dog dash', 'Toy Story Land', null, true],
  ['alien swirling saucers', 'Toy Story Land', 'Alien Swirling Saucers'],
  ['toy story mania', 'Toy Story Land', 'Toy Story Mania'],
  ['disney junior', 'Animation Courtyard', 'Disney Junior'],
  ['little mermaid', 'Animation Courtyard', 'The Little Mermaid'],
];

const AK = [
  ['flight of passage', 'Pandora', 'Flight of Passage'],
  ['navi river', 'Pandora', "Na'vi River Journey"],
  ['expedition everest', 'Asia', 'Expedition Everest', true],
  ['kali river', 'Asia', 'Kali River Rapids'],
  ['maharajah', 'Asia', 'Maharajah Jungle Trek'],
  ['kilimanjaro safaris', 'Africa', 'Kilimanjaro Safaris'],
  ['gorilla falls', 'Africa', 'Gorilla Falls'],
  ['dinosaur', 'DinoLand U.S.A.', 'DINOSAUR'],
  ['triceratop spin', 'DinoLand U.S.A.', 'TriceraTop Spin'],
  ['tough to be a bug', 'Discovery Island', "It's Tough to be a Bug!"],
  ['tree of life', 'Discovery Island'],
  ['rafiki', "Rafiki's Planet Watch"],
];

const DL = [
  ['disneyland railroad', 'Main Street, U.S.A.', 'Railroad'],
  ['main street', 'Main Street, U.S.A.'],
  ['great moments with mr lincoln', 'Main Street, U.S.A.', 'Mr. Lincoln'],
  ['walt disney a magical life', 'Main Street, U.S.A.', 'A Magical Life'],
  ['jungle cruise', 'Adventureland'],
  ['indiana jones', 'Adventureland', 'Indiana Jones Adventure'],
  ['enchanted tiki room', 'Adventureland', 'Enchanted Tiki Room'],
  ['adventureland treehouse', 'Adventureland', 'Adventureland Treehouse'],
  ['pirates of the caribbean', 'New Orleans Square'],
  ['haunted mansion', 'New Orleans Square', 'Haunted Mansion'],
  ['tianas bayou adventure', 'Bayou Country', "Tiana's Bayou Adventure"],
  ['davy crockett', 'Bayou Country', 'Explorer Canoes'],
  ['big thunder mountain', 'Frontierland', 'Big Thunder Mountain', true],
  ['mark twain', 'Frontierland', 'Mark Twain Riverboat'],
  ['sailing ship columbia', 'Frontierland'],
  ['shootin exposition', 'Frontierland', 'Shootin\' Exposition'],
  ['tom sawyer', 'Frontierland', "Pirate's Lair"],
  ['pirates lair', 'Frontierland', "Pirate's Lair"],
  ['matterhorn', 'Fantasyland', 'Matterhorn', true],
  ['peter pans flight', 'Fantasyland'],
  ['mr toad', 'Fantasyland', "Mr. Toad's Wild Ride"],
  ['pinocchio', 'Fantasyland', 'Pinocchio'],
  ['snow white', 'Fantasyland', 'Snow White'],
  ['alice in wonderland', 'Fantasyland', 'Alice in Wonderland'],
  ['mad tea party', 'Fantasyland'],
  ['dumbo', 'Fantasyland', 'Dumbo'],
  ['casey jr', 'Fantasyland', 'Casey Jr.'],
  ['storybook land', 'Fantasyland', 'Storybook Land'],
  ['king arthur carrousel', 'Fantasyland', 'Carrousel'],
  ['its a small world', 'Fantasyland', "it's a small world"],
  ['sleeping beauty castle', 'Fantasyland', 'Castle Walkthrough'],
  ['fantasyland theatre', 'Fantasyland'],
  ['runaway railway', "Mickey's Toontown", 'Runaway Railway'],
  ['roger rabbit', "Mickey's Toontown", 'Roger Rabbit'],
  ['gadgetcoaster', "Mickey's Toontown", 'GADGETcoaster', true],
  ['goofys how to play', "Mickey's Toontown", "Goofy's Play Yard"],
  ['minnies house', "Mickey's Toontown"],
  ['donalds duck pond', "Mickey's Toontown"],
  ['space mountain', 'Tomorrowland', 'Space Mountain', true],
  ['buzz lightyear', 'Tomorrowland', 'Buzz Lightyear'],
  ['star tours', 'Tomorrowland', 'Star Tours'],
  ['autopia', 'Tomorrowland'],
  ['astro orbitor', 'Tomorrowland'],
  ['submarine voyage', 'Tomorrowland', 'Nemo Submarines'],
  ['monorail', 'Tomorrowland', 'Monorail'],
  ['rise of the resistance', "Galaxy's Edge", 'Rise of the Resistance'],
  ['smugglers run', "Galaxy's Edge", 'Smugglers Run'],
];

const DCA = [
  ['guardians of the galaxy', 'Avengers Campus', 'Mission: BREAKOUT!'],
  ['web slingers', 'Avengers Campus', 'Web Slingers'],
  ['incredicoaster', 'Pixar Pier', 'Incredicoaster', true],
  ['toy story midway mania', 'Pixar Pier', 'Toy Story Midway Mania'],
  ['pal a round', 'Pixar Pier', 'Pixar Pal-A-Round'],
  ['inside out', 'Pixar Pier', 'Inside Out'],
  ['jessies critter carousel', 'Pixar Pier', "Jessie's Critter Carousel"],
  ['radiator springs racers', 'Cars Land'],
  ['maters', 'Cars Land', "Mater's Junkyard Jamboree"],
  ['luigis', 'Cars Land', "Luigi's Rollickin' Roadsters"],
  ['grizzly river run', 'Grizzly Peak'],
  ['soarin', 'Grizzly Peak', "Soarin'"],
  ['redwood creek', 'Grizzly Peak', 'Redwood Creek Challenge'],
  ['monsters inc', 'Hollywood Land', 'Mike & Sulley to the Rescue!'],
  ['little mermaid', 'Paradise Gardens', 'The Little Mermaid'],
  ['goofys sky school', 'Paradise Gardens', "Goofy's Sky School", true],
  ['golden zephyr', 'Paradise Gardens'],
  ['jumpin jellyfish', 'Paradise Gardens', "Jumpin' Jellyfish"],
  ['silly symphony swings', 'Paradise Gardens'],
  ['red car trolley', 'Buena Vista Street', 'Red Car Trolley'],
];

const BY_PARK = {
  'Magic Kingdom': MK,
  EPCOT,
  'Hollywood Studios': HS,
  'Animal Kingdom': AK,
  'Disneyland (CA)': DL,
  'California Adventure': DCA,
};
const compiled = Object.fromEntries(Object.entries(BY_PARK).map(([park, list]) => [park, list.map(([p, land, short = null, coaster = false]) => ({ key: norm(p), land, short, coaster }))]));

// { land, short, coaster } for one ride, with nulls where unknown.
//   parkName: as in parks.js; rideName: as the feed gives it
export function rideFacts(parkName, rideName) {
  const n = norm(rideName);
  const hit = (compiled[parkName] || []).find((e) => n.includes(e.key));
  return { land: hit?.land ?? null, short: hit?.short ?? null, coaster: !!hit?.coaster };
}
