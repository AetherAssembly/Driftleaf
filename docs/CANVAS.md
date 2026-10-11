# Workspace Canvas

The Canvas is a visual workspace for arranging note cards and database-view
shortcuts. Open **Canvas** in the sidebar, choose notes or databases to add,
and drag cards to arrange them. **Open** navigates to the note or database
inside Driftleaf; removing a card from the canvas does not delete its target.

The item list, target IDs, and positions are saved in the encrypted vault
manifest. Deleting a note or database removes its canvas card in the same
manifest update. A canvas supports up to 500 cards.

Canvas cards are references, not copies: note contents and database rows remain
in their existing encrypted files. The canvas currently stores one shared
workspace layout per vault; multiple named boards, connectors, zoom, and
embedded editable database views are future improvements.
