import { migrate } from '../src/migrator';

const url = process.argv[2] ?? process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error('ADMIN_DATABASE_URL is required (migrations run as the schema owner)');
  process.exit(1);
}

migrate(url)
  .then((applied) => {
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
