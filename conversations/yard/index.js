// The yard foreman. One node: the sheet behind him is the point, and this is the moment
// before it -- somebody is working here, and you are interrupting them.
const SAY = '"Big job just came in. Make it quick?"';
const OPTIONS = [
    // The mark this conversation is offered from is the yard itself, so opening it hands
    // the session straight to the refit sheet without going anywhere.
    ['I want to refit my ship.', { open: 'town:yard' }],
    ['Never mind.', { exit: true }],
];

export default (draft, { choice }) => {
    if (choice !== null) return OPTIONS[choice]?.[1] ?? { exit: true };
    return { say: SAY, options: OPTIONS.map((o) => o[0]) };
};
