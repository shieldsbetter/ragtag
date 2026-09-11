// A word for somebody who has just arrived, from whoever they walk up to first. It is an
// interrupt like any other: it sits on top of whatever that person's usual business is, and
// popping reveals it.
//
// Everybody in the town has one of these on their stack, and only one of them ever says it.
// The flag goes in `player` -- what this *conversation* knows about this player, which is
// keyed by the module's name rather than by who is speaking, so the word the harbourmaster
// had is the word the foreman no longer has.
const OPTION = "Let's get to business...";

export default (params, player, place, { choice }) => {
    // Somebody else got there first. Drop out without a word: the client never learns this
    // frame was here, and the conversation underneath begins as though it had been asked.
    if (player.welcomed) return { pop: true };
    if (choice !== null) {
        player.welcomed = true;
        return { pop: true };
    }
    return {
        say:
            `Welcome to ${place?.name ?? 'the port'}. The supplies you brought ` +
            'were urgently needed -- I hope the new ship serves you well.',
        options: [OPTION],
    };
};
