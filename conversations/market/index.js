// Whoever is minding the market stall. One node, the same shape as the yard's.
const SAY =
    '"We\'ve got whatever you need. Best prices for... well, a long way."';
const OPTIONS = [
    ['Let me see your wares.', { open: 'town:market' }],
    ['Never mind.', { exit: true }],
];

export default (params, player, { choice }) => {
    if (choice !== null) return OPTIONS[choice]?.[1] ?? { exit: true };
    return { say: SAY, options: OPTIONS.map((o) => o[0]) };
};
