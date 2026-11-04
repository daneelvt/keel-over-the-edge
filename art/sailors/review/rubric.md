# Judging a sailor

Every change to a sailor is judged twice before anyone else sees it: by
code, then by the picture. Code first, because vision misses what it
catches (a part floating a few millimetres off, a count, a millimetre of
cloth under the skin); the picture second, because the gates know
nothing of whether a coat reads as a coat.

## The order

1. **The gates pass.** The build fails on any (`metrics.py`, `motion.py`);
   a run that fails is not looked at for anything else.
2. **The questions are answered from the sheet,** each from the view it
   names, yes or no. Open critique ("does it look good?") is not asked:
   it finds little, and a judge looking at pictures agrees with people
   only moderately. Fixed views and specific questions are what works.
3. **Keep the best; revert.** A change that answers fewer questions yes,
   or moves a gate's measure the wrong way (the build lists what moved
   since the last run, and `compare.png` sets the last sheet beside this
   one), is undone, not built on.
4. **Count the passes.** A part reaches "recognisable" in two or three
   and "good" in five to ten; plan for them.

## The sheet's views

`sheet.png` in the run, one a version, always laid out the same:

- **front, side, back, top, three-quarter**: the look at rest, the
  palette's colours, orthographic. The top view settles what a
  three-quarter view misreads (a cocked hat's corners); the side view
  settles depth (a hand on the brow, a skirt standing off the rear).
- **face**: the head close, three-quarter. Faces are judged with hair and
  hat on, never bald.
- **wireframe**, **normals front/back** (as colours: a patch of the wrong
  colour is a flipped face), **uv front/back** (a checker: stretching and
  seams).
- **poke** and **seat**: in red, what came through the clothes, or
  through the boat, in the pose where most did. Both are empty when the
  gates pass; they are for the run that fails.
- **the posed set**: standing, seated at the helm, hiking (both in the
  boat), an arm raised, treading water, on the board, climbing in.
- **game camera**: behind and above the boat as the game starts, the
  figure about 64 pixels high, and its **silhouette** in black.
- **the silhouettes of every look** built, in a row at that size.

Each clip's `clip-<clip>.png`: eight frames across it from the **front**,
the **side** (the figure's left), the **profile** (its right) and the
**top**, and beneath them each chain's joints' speeds through the clip.

## Every look

From the silhouette row and the game camera:

- Is the look named from behind, in black, at 64 pixels, by its hat, hair
  or what hangs from it?
- Is no other look's silhouette the same?
- From above (top), is the hat's shape its own (a cocked hat's triangle,
  a tall crown, a knit cap's droop)?

From front, side, back:

- Does the figure stand 7.5 to 8 heads (asserted by the build), the head
  never large for the body?
- Do the clothes follow the figure: a waist where the body has one, the
  shoulder seam on the shoulder's point, no shelf off the rear (side)?
- Is everything the look's period shows from behind there from behind
  (back): a coat's vent, a scarf's tails, an apron's ties, a queue?

From the posed set:

- Seated and hiking, do the hips sit on the deck, the hands on tiller and
  sheet, the feet on the cockpit's floor?
- In each pose, does every part go where the body takes it (a skirt over
  the seat, not through the thighs; hair down the back)?

## Faces

The women (the owner's brief: an attractive French woman), from face and
front:

- Is the face oval, a little short, the forehead not high?
- Are the cheekbones high and soft, never hollow?
- Is the jaw narrow and tapered, the chin small?
- Is the nose slim and straight, slightly turned up?
- Are the eyes large and almond, their outer corners lifted?
- Are the brows thin, arched and set high?
- Are the lips full with a defined bow, the lower the fuller?
- Is the neck slender, and is there a hint of a smile?
- Is she about thirty (the two older looks older, still handsome)?

The men (handsome), from face and front:

- Are the jaw and chin defined, the nose straight?
- Is the brow clear and not heavy, the eyes open?
- Is the neck in proportion?
- Strong for the Bosun, dashing for the Cavalier, dignified for the Old
  Salt?

Every face, with every skin tone (the same shape on each):

- Does it push three to five features well off its sex's base, with one
  to three small asymmetries and a resting expression, and share its
  strongest feature with no other look?

## The bodies

From front, side, back (the owner's direction: the whole body, not the
face alone):

- The women: slim, toned, long-legged, a defined waist, a natural bust and
  hips, shoulders not narrow, a graceful neck?
- The men: athletic and lean, shoulders a little broader than the hips,
  never a bodybuilder's, a flat stomach, lightly defined arms and chest,
  long legs?
- The older looks: older, not heavier or softer?

## Garments

Each look's file lists its garments' questions, from their period
references; these are the ones every garment of its kind answers.

**A coat** (front, side, back, top, seated):

- Is it fitted to the waist, its fullness in the side pleats and the back
  vent, not flared all round?
- Are the front edges straight?
- Is it collarless, with a neckcloth?
- Are the buttons close, the pocket flaps there, the cuffs deep with the
  shirt's showing?
- Does its back skirt follow her curve and fall close, never hung from the
  rear's furthest point (side)?
- Seated, does it lie over the seat and the side deck?
- On a woman, is it shaped to her bust (breast by breast, never one span
  across), her waist and her hips, the sleeve slim and set on her own
  shoulder? On a man, little ease, no padding, a set-in sleeve?

**A shirt**:

- Does it show where the period's would (the neck, the cuffs below a
  coat's, the sleeves rolled where the look says)?
- Is it tucked in, the breeches' waistband over it (front)?

**Breeches** (front, back, seated):

- Do they end below the knee in a band?
- Is the waistband at the waist and lying flat?
- At the back, does the cloth follow the buttocks without slits or
  folds into the crease?

**A hat** (top first, then front, side, back):

- From above, is its outline its own (a cocked hat's three corners, the
  point at the front)?
- Does it sit on the head or the hair, level, nothing floating?

**Hair** (back, side):

- Does it read as hair from behind (a queue, a braid, curls), not a cap?
- Does it lie on the head and fall where the body takes it?

## The machines

From the posed set, the game camera and the silhouette beside a human's:

- Does it read as a machine from behind: the lantern at the nape, the
  neck's lames, the crest or swept plates, the metal?
- Is its silhouette a machine's by its structure, not by its light alone?
- Is the face carved in planes like a figurehead's, the lamp eyes amber in
  deep sockets, never a skull, a smooth mask or a visor slit?
- Is it none of the no-go list (green eyes, an all-gold humanoid with a
  smooth gold face, antlers or crowns, a tattered coat over a gaunt
  frame)?

## Motion

From the strips (front, side, profile, top) and the curves:

- Does the clip do what its name says, read from the side that shows it
  (a hand at the brow is judged in profile, not from the front)?
- Do the hands stay on what they hold?
- Does each move start in the hips and end in the hands (or start in the
  head, when the look leads), the curves' peaks staggered?
- Does nothing stop dead: the curves never flat through a hold?
- Is there nothing that pops: no spike in a curve the moves around it do
  not explain?
