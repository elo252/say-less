// Prompt decks for the three modes. Add your own freely — each deck is just an array.

const OBJECTS = [
  'a waffle iron', 'a skateboard', 'a lighthouse', 'a rubber duck', 'a tax return',
  'a volcano', 'a shopping cart', 'a harmonica', 'a parking ticket', 'a jellyfish',
  'a library card', 'a toaster', 'a hot air balloon', 'a sock puppet', 'a fire extinguisher',
  'a wedding cake', 'a traffic cone', 'a submarine', 'a houseplant', 'a vending machine',
  'a pirate ship', 'a microwave', 'a yoga mat', 'a lawnmower', 'a snow globe',
  "a dentist's chair", 'an umbrella', 'a disco ball', 'a garden gnome', 'a group chat',
  'a GPS', 'a cactus', 'a trampoline', 'a museum', 'a bowling ball',
  'a beehive', 'a forgotten password', 'a sandcastle', 'an elevator', 'a fortune cookie',
  'a grandfather clock', 'a bubble bath', 'a soccer referee', 'a paper airplane', 'a lava lamp',
];

const RANT_TOPICS = [
  'Why socks disappear in the dryer',
  'Why pigeons are secretly in charge',
  'The case for a fourth meal of the day',
  'Why Mondays should be illegal',
  'How to survive a zombie apocalypse with only office supplies',
  'Why cats knock things off tables',
  'The one correct way to cook an egg — defend it',
  'What aliens would find most confusing about humans',
  'Why the snooze button is a trap',
  'Pitch a brand-new Olympic sport',
  'Why you deserve a nap right now',
  'The worst superpower you could have',
  'Why the ocean is salty — confidently, accuracy optional',
  'Why houseplants are judging us',
  'Whether pineapple belongs on pizza',
  'The secret life of your fridge at night',
  'Why every meeting could have been an email',
  'A heartfelt eulogy for your old phone',
  'Teach us a sport you just invented',
  'Why the moon is overrated',
  'What your toaster thinks about all day',
  'How to become famous using only a spoon',
  'Why everyone should wear a cape',
  'Defend your weirdest habit',
  'The true history of the high five — make it up',
  'Why adults should get recess',
  'Sell us a slightly used cloud',
  'Why ducks would beat geese in a war',
  'The rules of a game you invented as a kid',
  'Why breakfast for dinner is a human right',
];

const PITCH_PROMPTS = [
  'Summarize the plot of Romeo and Juliet',
  'Explain the internet to a medieval peasant',
  'Explain how a credit card works to a 5-year-old',
  'Summarize World War I',
  'Explain photosynthesis to a goldfish',
  'Summarize the plot of The Lion King',
  'Explain blockchain to your grandparent',
  'Explain why the sky is blue',
  'Summarize the French Revolution',
  'Explain how vaccines work',
  'Explain taxes to an alien',
  'Summarize the plot of Titanic',
  'Explain gravity to a toddler',
  'Explain what a startup is',
  'Summarize the rise and fall of the Roman Empire',
  'Explain inflation to a kid with a piggy bank',
  'Explain how a rocket gets to space',
  'Summarize the plot of Cinderella',
  'Explain the stock market to a squirrel',
  'Explain why we sleep',
  'Summarize the theory of evolution',
  'Explain how Wi-Fi works',
  'Explain climate change to a polar bear',
  'Explain AI to a caveman',
  'Summarize the Moon landing',
  'Explain how elections work',
  'Summarize the plot of Jurassic Park',
  'Explain democracy to a cat',
  'Explain email to a carrier pigeon',
  'Summarize your own life so far',
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Pick a prompt for a mode, avoiding repeats within a game.
 * Returns { text, parts? } — `parts` holds the two objects for The Missing Link.
 */
function pickPrompt(mode, used = new Set()) {
  for (let attempt = 0; attempt < 60; attempt++) {
    let prompt;
    if (mode === 'link') {
      const a = rand(OBJECTS);
      let b = rand(OBJECTS);
      while (b === a) b = rand(OBJECTS);
      prompt = { text: `${cap(a)} + ${b}`, parts: [cap(a), cap(b)], key: [a, b].sort().join('|') };
    } else if (mode === 'ums') {
      const t = rand(RANT_TOPICS);
      prompt = { text: t, key: t };
    } else {
      const t = rand(PITCH_PROMPTS);
      prompt = { text: t, key: t };
    }
    if (!used.has(prompt.key) || attempt === 59) {
      used.add(prompt.key);
      return prompt;
    }
  }
}

module.exports = { pickPrompt, OBJECTS, RANT_TOPICS, PITCH_PROMPTS };
