const { onRequest } = require("firebase-functions/v2/https")
// The Firebase Admin SDK to access Firestore.
const { initializeApp } = require("firebase-admin/app")
const { getFirestore, Timestamp } = require("firebase-admin/firestore")
const { onDocumentCreated } = require("firebase-functions/v2/firestore")
const { setGlobalOptions } = require("firebase-functions/v2")
setGlobalOptions({ maxInstances: 10 })

initializeApp()
const { OpenAI } = require("openai")

async function updateMacros(macrosRef, macros) {
	const data = (await macrosRef.get()).data()
	const { calories, sodium, fat, protein, sugar, vitamins } = macros
	const newCalories = data.calories + calories.value * calories.servingSize
	const newSodium = data.sodium + sodium.value * sodium.servingSize
	const newFat = data.fat + fat.value * fat.servingSize
	const newProtein = data.protein + protein.value * protein.servingSize
	const newSugar = data.sugar + sugar.value * sugar.servingSize
	const newVitamins = data.vitamins + vitamins.value * vitamins.servingSize

	macrosRef.update({
		calories: newCalories,
		sodium: newSodium,
		fat: newFat,
		protein: newProtein,
		sugar: newSugar,
		vitamins: newVitamins,
	})

	return JSON.stringify({
		calories: newCalories,
		sodium: newSodium,
		fat: newFat,
		protein: newProtein,
		sugar: newSugar,
		vitamins: newVitamins,
	})
}

exports.chat = onRequest({ cors: true, memory: 1024 }, async (req, res) => {
	const openai = new OpenAI({
		apiKey: process.env.OPEN_AI_KEY,
	})
	const { msg } = req.body
	const uid = req.auth.uid
	const functions = [
		{
			name: "update_macros",
			description:
				"Update the user's macros based on what they ate or drank. If the user ate or drank something but serving size is not specified, it is assumed to be 1. If the user ate or drank multiple servings, specify the number of servings. For example, if the user ate 2 servings of a food, specify the serving size as 2. If the user ate 1/2 of a serving, specify the serving size as 0.5. Lastly, if the user ate or drank something that has no property like vitamins, assign that property with value and serving size as 0. For example, if the user drank regular water, assign sodium and some other properties with value and serving size as 0.",
			parameters: {
				type: "object",
				properties: {
					macros: {
						type: "object",
						properties: {
							calories: {
								type: "object",
								properties: {
									value: { type: "number" },
									servingSize: { type: "number" },
								},
							},
							sodium: {
								type: "object",
								properties: {
									value: { type: "number" },
									servingSize: { type: "number" },
								},
							},
							fat: {
								type: "object",
								properties: {
									value: { type: "number" },
									servingSize: { type: "number" },
								},
							},
							protein: {
								type: "object",
								properties: {
									value: { type: "number" },
									servingSize: { type: "number" },
								},
							},
							sugar: {
								type: "object",
								properties: {
									value: { type: "number" },
									servingSize: { type: "number" },
								},
							},
							vitamins: {
								type: "object",
								properties: {
									value: { type: "number" },
									servingSize: { type: "number" },
								},
							},
						},
					},
				},
				required: ["macros"],
			},
		},
	]

	const startDate = new Date()
	startDate.setHours(0, 0, 0, 0) // Start of the day
	const endDate = new Date()
	endDate.setHours(23, 59, 59, 999) // End of the day
	const startTimestamp = Timestamp.fromDate(startDate)
	const endTimestamp = Timestamp.fromDate(endDate)

	const userRef = getFirestore().collection("users").doc(uid)
	const dailyValsSnap = userRef
		.collection("dailyMacros")
		.where("date", ">=", startTimestamp)
		.where("date", "<=", endTimestamp)
		.limit(1)

	if ((await dailyValsSnap.get()).empty) {
		userRef.collection("dailyMacros").add({
			date: Timestamp.now(),
			calories: 0,
			sodium: 0,
			fat: 0,
			protein: 0,
			sugar: 0,
			vitamins: 0,
		})
	}

	const dailyVals = (await dailyValsSnap.get()).docs[0].data()
	const dailyValsId = (await dailyValsSnap.get()).docs[0].id
	const userData = (await userRef.get()).data()
	const {
		allergies,
		goalWeight,
		goalcals,
		goalfat,
		goalprotein,
		goalsodium,
		goalsugar,
		healthIssues,
	} = userData
	const { calories, sodium, fat, protein, sugar, vitamins } = dailyVals

	const history = (await userRef.get()).data().chatHistory
	let messages = [
		{
			role: "system",
			content: `You are a helpful nutrition assistant.
      Your job is to review a user's health info and daily macros then update the latter based on what the user tells you,
      such as when they eat or drink something. 
      Here's their health info:
      Allergies: ${allergies}
      Health Issues (list): ${healthIssues}
      Goal Weight: ${goalWeight}
      Goal Calories: ${goalcals}
      Goal Fat: ${goalfat}
      Goal Protein: ${goalprotein}
      Goal Sodium: ${goalsodium}
      Goal Sugar: ${goalsugar}
      Here are today's macros (if any):
      Calories: ${calories}
      Sodium: ${sodium}
      Fat: ${fat}
      Protein: ${protein}
      Sugar: ${sugar}
      Vitamins: ${vitamins}.
      Additionally, you must provide advice to the user based on their macros and/or health info when asked.`,
		},
	]
	messages = messages.concat(history)
	messages.push({ role: "user", content: msg })

	const response = await openai.chat.completions.create({
		model: "gpt-3.5-turbo",
		messages: messages,
		functions: functions,
		function_call: "auto",
	})

	const responseMessage = response.choices[0].message

	if (responseMessage.function_call) {
		// call the function
		// Note: the JSON response may not always be valid; be sure to handle errors
		const availableFunctions = {
			update_macros: updateMacros,
		}
		const functionName = responseMessage.function_call.name
		const functionToCall = availableFunctions[functionName]
		const functionArgs = JSON.parse(responseMessage.function_call.arguments)
		const functionResponse = functionToCall(
			userRef.collection("dailyMacros").doc(dailyValsId),
			functionArgs
		)

		// send the info on the function call and function response to GPT
		messages.push(responseMessage) // extend conversation with assistant's reply
		messages.push({
			role: "function",
			name: functionName,
			content: functionResponse,
		}) // extend conversation with function response
		const secondResponse = await openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: messages,
		}) // get a new response from GPT where it can see the function response
		messages.push(secondResponse.choices[0].message)
		userRef.update({
			chatHistory: messages,
		})
		return res.json({ msg: secondResponse.choices[0].message.content })
	}

	messages.push(response.choices[0].message)

	await userRef.update({
		chatHistory: messages,
	})

	res.json({ msg: response.choices[0].message.content })
})

exports.createuser = onDocumentCreated("users/{userId}", (event) => {
	const snapshot = event.data
	if (!snapshot) {
		console.log("No data associated with the event")
		return
	}
	const data = snapshot.data()
	if (!data) {
		console.log("Document was deleted")
		return
	}
	const uid = snapshot.id
	const userRef = getFirestore().collection("users").doc(uid)
	userRef.update({
		chatHistory: [],
	})
})
