# Hands Up

Live class answers for lessons where pupils have iPads.

- **Pupils** go to your Hands Up web address, type the class code and their name, and answer by typing, handwriting (Apple Pencil or finger) or tapping a multiple-choice option. They only ever see their own answers.
- **You** post a question, or a blank one when the question is already on your slide. Answers appear live on your screen. You star the best ones, pick which go on the board, leave private comments, lock iPads with *Pens down*, and see who is stuck if you've turned that on.
- **The board** (projector) shows only what you choose: the join code, the question, the multiple-choice results, the answers you picked (names hidden unless you switch them on), or the leaderboard.
- **Leaderboard:** each star is 1 point, counted for each class over today, the last 7 days, the last 30 days or all time. Only you see it until you put it on the board.
- **Lesson notes:** when you press *End lesson*, each pupil can download a PDF of the questions, their own answers, your comments and the answers you highlighted (without names). You can download a full class record for any lesson.
- **Question sets:** prepare questions before the lesson, or import them from a PowerPoint. The app suggests slides that contain a question mark and pulls out A/B/C/D options and slide pictures. Any class can use any set.

---

## Putting it online (about 15 minutes, once)

Hands Up is a small Node.js web app. It needs a host that **keeps files between restarts**, because that's where the classes, answers and leaderboard are saved. Two straightforward options:

### Option A: Railway (cheapest, about $5 a month)
1. Put this folder in a GitHub repository (github.com, then *New repository*, then *upload files*). Don't upload `node_modules` or `data`.
2. Go to **railway.com**, sign in with GitHub, and choose *New project*, then *Deploy from GitHub repo*, then pick the repository.
3. In the service, open **Variables** and add `DATA_DIR` = `/data` and `NODE_ENV` = `production`.
4. Right-click the service, choose **Attach volume**, and set the mount path to `/data`.
5. Under **Settings**, then **Networking**, click **Generate domain**. That address is what pupils type. Pick the EU region if offered.

### Option B: Render (about $7 a month plus a few pence for storage)
1. Put this folder in a GitHub repository as above.
2. Go to **render.com**, then *New*, then **Blueprint**, and pick the repository. The included `render.yaml` sets up everything, including a Frankfurt server and a 1 GB disk.
3. When it's live, Render gives you an address like `hands-up-xxxx.onrender.com`.

> Avoid free tiers that don't keep files. Your leaderboard and pupils' notes would vanish every time the server restarts.

### First time you open it
Go to `https://your-address/teacher` and set a teacher password (8+ characters). Then add your classes. Each gets a 5-letter join code.

### Trying it on your own computer first
Install Node.js 18 or newer from nodejs.org, then in this folder run:
```
npm install
npm start
```
Open http://localhost:3000/teacher on your computer. Pupils on the same Wi-Fi can use `http://<your computer's IP>:3000`, but school networks often block this, so use online hosting for real lessons.

---

## In a lesson

| You want to… | Do this |
|---|---|
| Get pupils in | Board shows the join code at the start. Pupils go to your address and type it. |
| Ask about the question on your slide | Leave the question box empty, pick the answer type, then **Ask the class**. Pupils see "Answer the question on the board". |
| Use prepared questions | Under *Prepared questions*, pick a set and press **Ask** next to each one. Asked ones are crossed off. |
| Show good answers | Press **Pick** on the answers you want, then **Show N on board**. Use **Present** (same screen) or **Open board window** (second screen). |
| Give a point | Press **Star** on an answer. The pupil gets a private "your teacher highlighted your answer" message. |
| Comment privately | Press **Comment** and choose a ready-made comment or type your own. Only that pupil sees it, and it goes in their notes. |
| Get attention | **Pens down** locks every iPad on "Eyes on the board". Press again to unlock. |
| See who's stuck | Turn on the **"I'm stuck" hand** for the class. Raised hands appear at the top of your screen, and only you see them. |
| Multiple choice | Tap a letter to mark the right answer, then **Show results on board**, then **Reveal answer**. |
| Finish | Press **End lesson**. Pupils get a **Download my lesson notes** button. |

Pupils who rejoin with the same name, for example on a different iPad, are matched back to their record. If two pupils share a name, ask them to add an initial.

---

## Data protection (UK GDPR)

- **What's stored:** pupils' names as typed, their answers and drawings, your stars and comments. No email addresses, passwords or accounts for pupils. No tracking or analytics.
- **Where:** only on your host's server, in the folder set by `DATA_DIR`. Choose an EU or UK region where offered. The Render setup uses Frankfurt.
- **Who sees what:** pupils see only their own answers and comments, plus answers you put on the board. The board hides names unless you turn them on. Handwritten answers can only be opened by you and the pupil who wrote them.
- **Deleting:** *Pupils* tab, then **Remove and delete data**, permanently deletes that pupil's answers, drawings and stars. Archiving a class hides it but keeps its data.
- **Backups:** *Settings and backup*, then **Download backup**, gives you one file with everything. Keep it as safely as you would a markbook.
- Check with your school's data protection lead before using it with classes. They may want a short DPIA, and your IT team may need to allow your web address.

## Files

| File | What it does |
|---|---|
| `server.js` | Web server and live connections |
| `store.js` | Saves everything to `DATA_DIR` |
| `pdf.js` | Pupil lesson notes and class record PDFs |
| `pptx.js` | Reads PowerPoint files for question import |
| `public/index.html`, `pupil.js`, `draw.js` | Pupil screen and handwriting pad |
| `public/teacher.html`, `teacher.js` | Teacher screens |
| `public/board.html`, `board.js` | Projector view |

## Ideas for later
- AI suggestions: have Claude pick out and word questions from a PowerPoint automatically (needs an Anthropic API key).
- Hide an individual answer, photo upload of paper working, spreadsheet export, co-teachers.
