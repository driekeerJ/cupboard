# Testen — PR #5 (issues #1, #2, #3)

## Automatisch: `npm run e2e` (~1 minuut)

Start een tweede, losse Obsidian (eigen gebruikersmap, debugpoort) met een
wegwerpkluis uit `demo/`, in Obsidians telefoonmodus met de insets van een
Android-telefoon met drieknopsnavigatie. Je eigen Obsidian blijft gewoon
openstaan. 23 checks:

| Blok | Wat |
| --- | --- |
| A. Winkellijst (#3) | tik vinkt meteen af · rij blijft even staan en zakt dan naar het eind van zijn schap · drie snelle tikken zakken samen · terugtikken · vasthouden opent het product zonder af te vinken · een aanraakveeg vinkt niets af · rond vinkje en hoeveelheid-knop werken nog · losse boodschap: tik = weg, vasthouden = bewerken |
| B. Systeembalken (#2) | Add item, New product en het productscherm: knoppen boven de navigatiebalk, kop onder de statusbalk |
| C. Toevoegen (#1) | + Shop maakt een winkel en springt erheen · annuleren maakt niets · New recipe vanuit de planner schrijft en opent een recept met leeg `servings` · dubbele naam opent het bestaande · beide commands bestaan |
| D. Instelling | Tick boxes on the right zet het vinkje rechts en weer terug |
| E. Uitleg (#3) | To check toont nooit getelde producten · Package size-uitleg volgt de knop · productnotitie en planblok in het Engels |
| F. Console | geen fouten van Cupboard |

Tegenproef gedaan: met de CSS van vóór de fix zakken de drie B-checks
(knop op 828px, navigatiebalk vanaf 796px — de bug uit #2), met de build van
`main` zakken A, C, D en E.

## Handmatig: wat een emulator niet ziet (~3 minuten, op je telefoon)

Testkluis *Cupboard test* in iCloud, of je eigen kluis na `npm run build:deploy`
en een volledige herstart. Check eerst dat de build nieuw is: Instellingen →
Cupboard heeft onderaan het kopje **Shopping**.

- [ ] Winkellijst: een naam **vasthouden** geeft geen iOS-tekstselectie of -menu over het productscherm heen
- [ ] Het **wegglijden** na afvinken voelt rustig, niet schokkerig
- [ ] Een losse boodschap toevoegen met het **toetsenbord open**: Add blijft bereikbaar
- [ ] Een productformulier: de kop staat netjes onder de notch / Dynamic Island

Android met drieknopsnavigatie: laat de melder van #2 het bevestigen.
