// A piece of work, which is a conversation with two extra exports: `offer` says whether it
// is on the table, and `describe` writes the line it reads as in the quest list. Everything
// else about it is an ordinary conversation module.
//
// The quest itself is a thing in the world, not state kept here. This module owns what it
// *means*: what counts towards it, when it is done, and what to say at each stage. Every
// branch ends in a pop, because a frame that stayed would sit on top of the foreman's own
// business and the yard could never be reached past it.
const NEEDED = 3;
const cleared = (kills) => kills.cache?.nest ?? 0;
// What is left to do. The count when the work was taken is kept in the quest, because
// caches broken before anybody asked are not work done for them.
const left = (quest, kills) =>
    Math.max(0, NEEDED - (cleared(kills) - quest.state.from));

// Offered by a yard that has not already had this out of you -- and still offered while it
// is in hand, because "Any work?" is also how you report back: the frame that opens is the
// one that knows what is left and pays out. A finished quest is kept rather than deleted,
// which is what makes this answerable without a flag anywhere.
export const offer = ({ from, src, quests }) =>
    from === 'yard' && !quests.some((q) => q.src === src && q.done);

export const describe = (quest, { kills }) =>
    `Destroy ${NEEDED} nest caches. (${left(quest, kills)} remaining)`;

export default (
    params,
    player,
    place,
    { choice, quest, kills, takeQuest, finishQuest, give },
) => {
    if (!quest) {
        if (choice === 0) {
            takeQuest({ from: cleared(kills) });
            return {
                say:
                    '"Good. Three caches, and do not come back telling me the guard ' +
                    'talked you out of it."',
                options: ['Understood.'],
            };
        }
        if (choice !== null) return { pop: true }; // not now, and not raised again today
        return {
            say:
                '"There is, as it happens. The nests out past the rim are sitting on ore ' +
                'this yard could use. Break three of their caches and there is a berth in ' +
                'it for you."',
            options: ["I'll take it.", 'Not now.'],
        };
    }

    if (left(quest, kills) === 0) {
        // Paid on the way out rather than on the way in: this node is shown every time the
        // sheet is opened, and a reward handed over at the sight of it is a reward handed
        // over as many times as you like. Finished only once it is actually in a hold, so
        // a hull lost between the shooting and the telling costs the pay and not the work.
        if (choice !== null) {
            if (!give('flak'))
                return {
                    say: '"I cannot load it into thin air. Bring me a hull."',
                    options: ['Right.'],
                };
            finishQuest();
            return { pop: true };
        }
        return {
            say:
                '"Three of them. That is the work done, and done properly." He nods at a ' +
                'crate by the gantry. "Close-in gun off a hull we broke up last season. ' +
                'It will not scratch a carrier, but nothing small is getting past it. ' +
                'Have the yard bolt it on."',
            options: ['Glad to help.'],
        };
    }
    if (choice !== null) return { pop: true };
    return {
        say: `"${left(quest, kills)} more caches. They are not going to break themselves."`,
        options: ['I will see to it.'],
    };
};
