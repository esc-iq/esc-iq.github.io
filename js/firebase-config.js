// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCYuVEURUE4GIebvS14KJMm3EdMpL9u9tw",
  authDomain: "engineering-students-community.firebaseapp.com",
  projectId: "engineering-students-community",
  storageBucket: "engineering-students-community.firebasestorage.app",
  messagingSenderId: "371432549665",
  appId: "1:371432549665:web:4d3b9617243731fb06e260",
  measurementId: "G-6L0FRLSVZW"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
