import { getProspectiveValidationCohort } from "../trading/prospective-validation-cohort.js";

const limitFlag = process.argv.find((value) => value.startsWith("--limit="));
const limit = limitFlag ? Number(limitFlag.slice("--limit=".length)) : 100;

const result = await getProspectiveValidationCohort(limit);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
