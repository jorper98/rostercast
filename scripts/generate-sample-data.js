const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const BACKUP_FILE = path.join(DATA_DIR, `members-backup-${Date.now()}.json`);

const SAMPLE_FIRST_NAMES = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery',
  'Sam', 'Peyton', 'Dakota', 'Reese', 'Rowan', 'Sage', 'Jamie', 'Skyler',
  'Drew', 'Cameron', 'Hayden', 'Kendall', 'Emerson', 'Finley', 'Marlowe', 'Sutton'
];

const SAMPLE_LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas',
  'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White'
];

const CITIES = [
  { city: 'Peoria', state: 'AZ', zip: '85383', lat: 33.5806, lng: -112.2374 },
  { city: 'Phoenix', state: 'AZ', zip: '85001', lat: 33.4484, lng: -112.0740 },
  { city: 'Glendale', state: 'AZ', zip: '85301', lat: 33.5387, lng: -112.1860 },
  { city: 'Surprise', state: 'AZ', zip: '85374', lat: 33.6292, lng: -112.3679 },
  { city: 'Scottsdale', state: 'AZ', zip: '85251', lat: 33.4942, lng: -111.9261 },
  { city: 'Mesa', state: 'AZ', zip: '85201', lat: 33.4152, lng: -111.8315 },
  { city: 'Tempe', state: 'AZ', zip: '85281', lat: 33.4255, lng: -111.9400 },
  { city: 'Chandler', state: 'AZ', zip: '85224', lat: 33.3062, lng: -111.8413 }
];

const CLUBS = ['Kiva', 'Mita', ''];
const APPROVED_VALUES = ['yes', 'no', ''];
const MAILING_LIST_VALUES = ['Yes', 'No', ''];
const FULLTIME_PARTTIME_VALUES = ['Full Time', 'Part Time', ''];
const TAGS = ['social', 'events', 'newmembers', 'volunteers', 'board', 'twgwomenlrcgamenight'];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())).toISOString();
}

function jitterCoordinate(base, range) {
  return base + (Math.random() - 0.5) * range;
}

function generateSampleMembers(count = 24) {
  const members = [];

  for (let i = 0; i < count; i++) {
    const firstName = randomItem(SAMPLE_FIRST_NAMES);
    const lastName = randomItem(SAMPLE_LAST_NAMES);
    const location = randomItem(CITIES);
    const approved = randomItem(APPROVED_VALUES);
    const club = randomItem(CLUBS);
    const memberTags = [];

    if (Math.random() > 0.5) {
      memberTags.push(randomItem(TAGS));
    }
    if (Math.random() > 0.7) {
      memberTags.push(randomItem(TAGS));
    }

    const member = {
      id: Date.now() + i,
      first_name: firstName,
      last_name: lastName,
      address: `${randomInt(100, 9999)} Sample St`,
      city: location.city,
      state: location.state,
      zip: location.zip,
      phone: `555-${randomInt(100, 999)}-${randomInt(1000, 9999)}`,
      phone_2: '',
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      fromarea: randomItem(['WA', 'OR', 'CA', 'NV', '']),
      club: club,
      mailing_list: randomItem(MAILING_LIST_VALUES),
      fulltime_parttime: randomItem(FULLTIME_PARTTIME_VALUES),
      approved: approved,
      tags: [...new Set(memberTags)],
      coordinates: approved === 'yes' ? {
        lat: jitterCoordinate(location.lat, 0.08),
        lng: jitterCoordinate(location.lng, 0.08),
        geocoded_at: randomDate(new Date('2025-01-01'), new Date()),
        geocode_source: 'sample'
      } : null,
      created_at: randomDate(new Date('2024-01-01'), new Date())
    };

    members.push(member);
  }

  return members;
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(MEMBERS_FILE)) {
    const existing = fs.readFileSync(MEMBERS_FILE, 'utf8');
    try {
      const existingData = JSON.parse(existing);
      if (Array.isArray(existingData) && existingData.length > 0) {
        fs.writeFileSync(BACKUP_FILE, existing);
        console.log(`Backed up existing members.json to ${path.basename(BACKUP_FILE)}`);
      }
    } catch (error) {
      console.warn('Existing members.json is not valid JSON; skipping backup.');
    }
  }

  const sampleMembers = generateSampleMembers();
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(sampleMembers, null, 2));
  console.log(`Generated ${sampleMembers.length} sample members in ${MEMBERS_FILE}`);
  console.log(`Approved: ${sampleMembers.filter(m => m.approved === 'yes').length}`);
  console.log(`With coordinates: ${sampleMembers.filter(m => m.coordinates?.lat).length}`);
}

main();
