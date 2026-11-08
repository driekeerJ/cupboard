# Testen — focusmodus in de kookmodus

## Automatisch: `npm run e2e` (~1 minuut)

Blok **G. Cook mode: focus** draait in dezelfde tweede Obsidian in
telefoonmodus als de rest:

| Check | Wat |
| --- | --- |
| Volledig scherm | Focus opent een laag die het hele venster bedekt, tabbladen en balken incluis; de eerste dia is Ingredients |
| Vanzelf door | alle regels op een dia afvinken schuift de volgende dia in |
| Notitie | de vinkjes staan als `- [x]` in de sessienotitie |
| Bladeren | naar links vegen gaat vooruit, Back gaat terug |
| Systeembalk | Next staat boven de navigatiebalk van Android |
| Sluiten | × sluit de laag; de lijst eronder toont dezelfde vinkjes |
| Command | `cook-focus` bestaat |

## Handmatig (~3 minuten)

Eigen kluis na `npm run build:deploy` en een **volledige herstart**.

- [ ] **iPad**: Focus bedekt alles, ook de statusbalk van Obsidian; niets onder de notch of de thuisbalk
- [ ] **iPad**: het scherm blijft aan als je een paar minuten niets doet
- [ ] **Telefoon**: vegen bladert, en opent níet de zijbalk van Obsidian
- [ ] **Telefoon**: een timer in een stap starten vinkt de stap niet af; als hij afloopt komt de melding bóven de laag
- [ ] **Computer**: pijltjestoetsen bladeren, Esc sluit
- [ ] **Computer**: de kookweergave in een los venster (popout): Focus opent in dát venster
- [ ] Een vinkje via Sync van een ander apparaat verschijnt in de open focuslaag
- [ ] Na de laatste dia: "All done"; met nog iets open: "Almost there" en **Show me** springt ernaartoe
