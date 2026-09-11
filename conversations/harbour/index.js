// The harbourmaster: the default frame under everybody's stack at the starting town.
//
// A conversation holder is one function. It is handed three immer drafts and returns the
// next step; mutate any of them freely.
//
//   params   this frame's own state, which dies when the frame pops
//   player   what this conversation knows about this player, wherever they meet it
//   place    what the set piece knows, shared by everybody it put in the world --
//            null if whoever is speaking was not put there by one
//
// Where it is in its own tree is state like anything else, which is what makes resuming
// after a reconnect free: the frame already knows. What has to outlive the frame goes in
// one of the other two, by how widely it should be known.
const NODES = {
    hello: {
        say:
            'Harbourmaster leans on the rail. "New hull, is it? We do not get many ' +
            'through here since the lanes closed. What do you want?"',
        options: [
            ['What is there to do around here?', { at: 'work' }],
            ['I have ore to sell.', { open: 'town:market' }],
            ['My ship needs work.', { open: 'town:yard' }],
            ['Nothing. Good day.', { exit: true }],
        ],
    },
    work: {
        say:
            '"Out there, mostly. Rock worth cutting, and nests worth clearing if you ' +
            'have the guns for it. Bring back what you find -- the market pays, and the ' +
            'yard will bolt it on."',
        options: [
            ['Nests?', { at: 'nests' }],
            ['Then I will see to my ship.', { open: 'town:yard' }],
            ['Understood.', { exit: true }],
        ],
    },
    nests: {
        say:
            '"Fighters standing over a cache. They come at you and they do not stop. ' +
            'Whatever is in the cache is yours if you are still flying afterwards."',
        options: [
            ['Anything else worth knowing?', { at: 'work' }],
            ['I will keep it in mind.', { exit: true }],
        ],
    },
};

export default (params, player, place, { choice, start }) => {
    // Taken up -- walked up to, or uncovered by whatever was above popping -- so begin at
    // the top rather than in the middle of an exchange nobody remembers having. A
    // reconnect is not this: it arrives with start false and gets the node it was on.
    if (start) params.at = 'hello';
    else if (choice !== null) {
        const opt = NODES[params.at]?.options[choice];
        if (!opt) return { exit: true };
        if (opt[1].open || opt[1].exit) return opt[1];
        params.at = opt[1].at;
    }
    const node = NODES[params.at];
    if (!node) return { pop: true };
    return { say: node.say, options: node.options.map((o) => o[0]) };
};
