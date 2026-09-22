import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
const [,,icName,password='ChangeMe-123!'] = process.argv;
if(!icName){console.error('Usage: npm run db:seed-owner -- <IC-NAME> [password]');process.exit(1)}
const count=db.prepare("SELECT COUNT(*) c FROM users WHERE role='OWNER'").get().c;if(count>=4){console.error('Maximum of 4 owners reached.');process.exit(1)}
let u=db.prepare('SELECT * FROM users WHERE ic_name=?').get(icName);
if(u){db.prepare("UPDATE users SET role='OWNER',status='ACTIVE' WHERE id=?").run(u.id);console.log(`Promoted ${icName} to OWNER.`)}else{const hash=bcrypt.hashSync(password,12);db.prepare("INSERT INTO users(ic_name,password_hash,role) VALUES(?,?, 'OWNER')").run(icName,hash);console.log(`Created OWNER ${icName}. Change the password after first login.`)}
