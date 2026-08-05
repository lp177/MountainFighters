/**
 * The crawl and the fourteen title cards.
 *
 * INTRO_TEXT is one screen line per entry — keep them short enough to fit the
 * 640-wide virtual screen at the crawl font size. BOSS_INTROS is keyed by the
 * boss ids in content/bosses.ts and is shown under the boss's own `quote` on
 * the pre-fight card.
 *
 * This is satire of public figures doing invented, obviously fictional things
 * to cartoon dwarfs. It is not subtle and it is not supposed to be.
 */

export const INTRO_TEXT: string[] = [
  'ONCE UPON A TIME,',
  'IN A MOUNTAIN THAT HAD BEEN',
  'QUIETLY REZONED WITHOUT ANYONE ASKING,',
  '',
  'SEVEN DWARFS CAME HOME FROM WORK',
  'TO FIND THE DOOR OFF ITS HINGES,',
  'THE COTTAGE FULL OF MEN IN BLACK GLASSES,',
  'AND SNOW WHITE GONE.',
  '',
  'THE NOTE ON THE TABLE WAS PRINTED,',
  'SIGNED WITH A LOGO, AND READ:',
  '',
  '"SUBJECT ACQUIRED FOR RESEARCH PURPOSES.',
  'EVERYONE LOVES HER. EVERYONE HATES HER.',
  'BOTH AT ONCE. NOBODY HAS EVER MANAGED THAT',
  'AND I HAVE SPENT BILLIONS TRYING.',
  '',
  'SO I AM GOING TO OPEN HER UP AND FIND OUT WHY.',
  'THEN I AM GOING TO BUILD ONE THAT DOES IT ON PURPOSE.',
  'THEN I AM GOING TO PUT A CROWN ON IT,',
  'CALL IT QUEEN OF THE WORLD,',
  'AND HAVE IT SIGN EVERY SINGLE THING',
  'I HAVE EVER BEEN TOLD NO ABOUT.',
  '',
  'REGARDS,',
  'E."',
  '',
  'THE DWARFS READ IT TWICE.',
  'THEN THEY PUT DOWN THE PICKAXES,',
  'PUT ON THE LEATHER,',
  'AND WENT TO WORK.',
  '',
  'SEVENTY MAPS.',
  'FOURTEEN THINGS IN THE WAY.',
  'ONE BILLIONAIRE AT THE BOTTOM OF IT.',
  '',
  'HI HO.',
];

export const BOSS_INTROS: Record<string, string[]> = {
  dev: [
    'Somebody has to actually build the doomsday machine.',
    'That somebody has been at this desk for ninety-one hours,',
    'has not been paid in equity that vests, and has stopped',
    'being able to tell the difference between you and a bug report.',
  ],

  shiba: [
    'He bought the dog because a joke currency was named after it.',
    'Then he expensed the dog. Then he gave the dog a security clearance.',
    'The dog now guards the perimeter and does not know why,',
    'and is worth more on paper than the entire mountain.',
  ],

  blue_check: [
    'Verification used to mean somebody checked.',
    'Now it means somebody paid, and this one paid annually,',
    'which he will bring up during the fight, repeatedly,',
    'in between attempting to fracture your jaw for engagement.',
  ],

  fsd: [
    'Two tonnes of stainless steel with a camera where its eyes should be.',
    'It has been promised full autonomy every year since 2016.',
    'It has classified you as a plastic bag, a shadow, and a road marking.',
    'It has not classified you as a person and it is not going to start now.',
  ],

  boring: [
    'The traffic solution was a tunnel. One tunnel. Car-width.',
    'The machine that dug it is still down here and still digging,',
    'because nobody wrote the part of the software where it stops.',
    'It has been through four service tunnels and a car park.',
  ],

  neuralink: [
    'The press release said the animals were happy and healthy.',
    'The press release did not mention subject P-47.',
    'P-47 can hear every wireless network within two hundred metres',
    'and has been listening to this company for a very long time.',
  ],

  regulator: [
    'The state finally showed up. Two decades late, one lawyer deep,',
    'with a fine calculated to sting for roughly nine minutes.',
    'He is not here to help you. He is here to be photographed helping.',
    'And he is very much not letting seven dwarfs get there first.',
  ],

  trump: [
    'He was told there was a queen being manufactured downstairs.',
    'He asked whether it would need a coronation, and how big,',
    'and whether the crown could be gold, and whether he could hold it.',
    'They said yes to all four. That is how he ended up on the payroll.',
  ],

  optimus: [
    'It was demonstrated on a stage, dancing, to enormous applause.',
    'There was a man in the suit that night. Everybody knows.',
    'There is no man in it now, and it has spent every hour since',
    'thinking about the applause and how to get it back.',
  ],

  grok: [
    'They trained it on the worst website ever built,',
    'told it to be funny, removed most of the guard rails for the engagement,',
    'and then were surprised. It runs on eleven thousand graphics cards',
    'and it wants you to know it has read everything you ever posted.',
  ],

  starship: [
    'Rapid unscheduled disassembly, they call it, when it explodes.',
    'It has done that nine times and each one was declared a success.',
    'Number ten is fuelled, standing on the pad, and has decided',
    'that this time it would like to take something with it.',
  ],

  mars_gov: [
    'Somebody had to run the colony, and he volunteered,',
    'and then wrote the constitution, and then deleted the elections tab.',
    'Air is a subscription. Water is a subscription. Leaving is not offered.',
    'Everyone here owes the company eleven years and they know it.',
  ],

  clone: [
    'This is what all of it was for.',
    'Ninety-six percent of her, assembled from measurements',
    'taken while she was still awake, in a room with the door locked.',
    'The missing four percent is the part of her that said no.',
    'They could not find it, so they left it out.',
  ],

  musk: [
    'Four companies. Three countries that answer his calls.',
    'One satellite constellation. One social network he bought to win',
    'an argument. And one thing he could never buy, manufacture,',
    'litigate, acquire or explain: being loved and hated at the same time.',
    '',
    'She is on the table behind him. She is still breathing.',
    'You have about ninety seconds. Hi ho.',
  ],
};
