// The yard foreman. The sheet behind him is the point, and this is the moment before it --
// somebody is working here, and you are interrupting them.
const SAY = '"Big job just came in. Make it quick?"';

export default (params, player, place, { choice, gatherWork }) => {
    // Only offered when there is something to offer. Asking costs a pass over the work
    // that exists, which is why it is a call rather than something handed to every step.
    const work = gatherWork();
    const options = [
        // The mark this conversation is offered from is the yard itself, so opening it
        // hands the session straight to the refit sheet without going anywhere -- and
        // without naming which yard, so one module serves every one of them.
        ['I want to refit my ship.', { open: true }],
        ...(work.length ? [['Any work?', { push: work[0] }]] : []),
        ['Never mind.', { exit: true }],
    ];
    if (choice !== null) return options[choice]?.[1] ?? { exit: true };
    return { say: SAY, options: options.map((o) => o[0]) };
};
