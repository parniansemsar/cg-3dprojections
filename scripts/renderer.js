import * as CG from './transforms.js';
import { Matrix, Vector } from "./matrix.js";

const LEFT =   32; // binary 100000
const RIGHT =  16; // binary 010000
const BOTTOM = 8;  // binary 001000
const TOP =    4;  // binary 000100
const FAR =    2;  // binary 000010
const NEAR =   1;  // binary 000001
const FLOAT_EPSILON = 0.000001;

class Renderer {
    // canvas:              object ({id: __, width: __, height: __})
    // scene:               object (...see description on Canvas)
    constructor(canvas, scene) {
        this.canvas = document.getElementById(canvas.id);
        this.canvas.width = canvas.width;
        this.canvas.height = canvas.height;
        this.ctx = this.canvas.getContext('2d');
        this.scene = this.processScene(scene);
        this.enable_animation = true;  
        this.start_time = null;
        this.prev_time = null;
    }

    //
    updateTransforms(time, delta_time) {
        // TODO: update any transformations needed for animation
        this.prepareModels();
        let t = time / 1000.0;      // ms -> s

        for (let i = 0; i < this.scene.models.length; i++) {
            let model = this.scene.models[i];
            if (!model.hasOwnProperty('animation')) {
                continue;
            }
            // angle = revolutions oer second * 2 pi * seconds
            let theta = model.animation.rps * 2 * Math.PI * t;

            let rotate = new Matrix(4, 4);
            if (model.animation.axis === 'x') {
                CG.mat4x4RotateX(rotate, theta);
            }
            else if (model.animation.axis === 'y') {
                CG.mat4x4RotateY(rotate, theta);
            }
            else {
                CG.mat4x4RotateZ(rotate, theta);
            }

            // rotate about the model's own center: move center to origin, rotate, move back
            let to_origin = new Matrix(4, 4);
            CG.mat4x4Translate(to_origin, -model.center.x, -model.center.y, -model.center.z);
            let back = new Matrix(4, 4);
            CG.mat4x4Translate(back, model.center.x, model.center.y, model.center.z);
            model.matrix = Matrix.multiply([back, rotate, to_origin]);
        }
    }

    //
    rotateLeft() {
        this.rotateCamera(Math.PI / 36);    // turn keft 5 degrees around v
    }
    
    //
    rotateRight() {
        this.rotateCamera(-Math.PI / 36);   // turn right 5 degrees around v
    }
    
    //
    moveLeft() {
        this.moveCamera(this.getCameraAxes().u, -1);    // A: along -u
    }
    
    //
    moveRight() {
        this.moveCamera(this.getCameraAxes().u, 1);     // D: along +u 
    }
    
    //
    moveBackward() {
        this.moveCamera(this.getCameraAxes().n, 1);     // S: along +n (backward)
    }
    
    //
    moveForward() {
        this.moveCamera(this.getCameraAxes().n, -1);    // W: along -n (forward)
    }

    //
    draw() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        //this.drawLine(line.pt0.x, line.pt0.y, line.pt1.x, line.pt1.y)

        // TODO: implement drawing here!
        // For each model
        //   * For each vertex
        //     * transform endpoints to canonical view volume
        //   * For each line segment in each edge
        //     * clip in 3D
        //     * project to 2D
        //     * translate/scale to viewport (i.e. window)
        //     * draw line
        this.prepareModels();

        let view = this.scene.view;
        // N_per: world -> canonical view volume
        let n_per = CG.mat4x4Perspective(view.prp, view.srp, view.vup, view.clip);
        // V * M_per: canonical view volume -> projected onto z = -1 -> viewpoint (pixels)
        let v_mper = 
            Matrix.multiply([CG.mat4x4Viewport(this.canvas.width,
                this.canvas.height), CG.mat4x4MPer()]);
        // near plane in the canonical view volume
        let z_min = -view.clip[4] / view.clip[5];

        // For each model
        for (let i = 0; i < this.scene.models.length; i++) {
            let model = this.scene.models[i];

            //  * For each vertex
            //    * transform endpoints to canonical view volume
            let transform = Matrix.multiply([n_per, model.matrix]);
            let canonical = [];
            for (let j = 0; j < model.vertices.length; j++) {
                canonical.push(Matrix.multiply([transform, model.vertices[j]]));
            }

            // * For each line segment in each edge
            for (let j = 0; j < model.edges.length; j++) {
                let edge = model.edges[j];
                for (let k = 0; k < edge.length - 1; k++) {
                    let a = canonical[edge[k]];
                    let b = canonical[edge[k + 1]];
                    let line = {pt0: CG.Vector4(a.x, a.y, a.z, a.w),
                                pt1: CG.Vector4(b.x, b.y, b.z, b.w)};
                    //    * clip in 3D
                    line = this.clipLinePerspective(line, z_min);
                    if (line == null) {
                        continue;
                    }

                    //    * project to 2D
                    //    * trnaslate/scale to viewport (i.e. window)
                    let p0 = Matrix.multiply([v_mper, line.pt0]);
                    let p1 = Matrix.multiply([v_mper, line.pt1]);

                    //    * draw line (divide by w first)
                    this.drawLine(p0.x / p0.w, p0.y / p0.w, p1.x / p1.w, p1.y / p1.w);
                }
            }
        }
    }

    // Get outcode for a vertex
    // vertex:       Vector4 (transformed vertex in homogeneous coordinates)
    // z_min:        float (near clipping plane in canonical view volume)
    outcodePerspective(vertex, z_min) {
        let outcode = 0;
        if (vertex.x < (vertex.z - FLOAT_EPSILON)) {
            outcode += LEFT;
        }
        else if (vertex.x > (-vertex.z + FLOAT_EPSILON)) {
            outcode += RIGHT;
        }
        if (vertex.y < (vertex.z - FLOAT_EPSILON)) {
            outcode += BOTTOM;
        }
        else if (vertex.y > (-vertex.z + FLOAT_EPSILON)) {
            outcode += TOP;
        }
        if (vertex.z < (-1.0 - FLOAT_EPSILON)) {
            outcode += FAR;
        }
        else if (vertex.z > (z_min + FLOAT_EPSILON)) {
            outcode += NEAR;
        }
        return outcode;
    }

    // Clip line - should either return a new line (with two endpoints inside view volume)
    //             or null (if line is completely outside view volume)
    // line:         object {pt0: Vector4, pt1: Vector4}
    // z_min:        float (near clipping plane in canonical view volume)
    clipLinePerspective(line, z_min) {
        let p0 = CG.Vector3(line.pt0.x, line.pt0.y, line.pt0.z); 
        let p1 = CG.Vector3(line.pt1.x, line.pt1.y, line.pt1.z);
        let out0 = this.outcodePerspective(p0, z_min);
        let out1 = this.outcodePerspective(p1, z_min);

        //Base Cases : trivially accept or reject
        if ((out0 | out1) == 0){
            return line
        }
        else if ((out0 & out1) != 0){
            return null
        }

        //Find intersect
        else{
            let point, out, t

            // Ensure point is outside view
            if(out0 != 0){
                point = p0
                out = out0
            } else {
                point = p1
                out = out1
            }

            let deltaX = p1.x - p0.x
            let deltaY = p1.y - p0.y
            let deltaZ = p1.z - p0.z

            // t is measured from p0 (x = p0.x + t * deltaX)
            if (out & LEFT){ // L of left
                t = (-p0.x + p0.z) / (deltaX - deltaZ)
            }
            else if (out & RIGHT){ // R of right
                t = (p0.x + p0.z) / (-deltaX - deltaZ)
            }
            else if (out & BOTTOM){ // Below bottom
                t = (-p0.y + p0.z) / (deltaY - deltaZ)
            }
            else if (out & TOP){ // Above top
                t = (p0.y + p0.z) / (-deltaY - deltaZ)
            }
            else if (out & FAR){ // Farther than far
                t = (-1 - p0.z) / deltaZ
            }
            else { // Closer than near
                t = (p0.z - z_min) / (-deltaZ)
            }
            let x = p0.x + t * deltaX
            let y = p0.y + t * deltaY
            let z = p0.z + t * deltaZ

            if(out0 != 0){
                line.pt0 = CG.Vector4(x,y,z,1)
            } else {
                line.pt1 = CG.Vector4(x,y,z,1)
            }

            return this.clipLinePerspective(line, z_min)
        }
    }




    //
    animate(timestamp) {
        // Get time and delta time for animation
        if (this.start_time === null) {
            this.start_time = timestamp;
            this.prev_time = timestamp;
        }
        let time = timestamp - this.start_time;
        let delta_time = timestamp - this.prev_time;

        // Update transforms for animation
        this.updateTransforms(time, delta_time);

        // Draw slide
        this.draw();

        // Invoke call for next frame in animation
        if (this.enable_animation) {
            window.requestAnimationFrame((ts) => {
                this.animate(ts);
            });
        }

        // Update previous time to current one for next calculation of delta time
        this.prev_time = timestamp;
    }

    //
    updateScene(scene) {
        this.scene = this.processScene(scene);
        if (!this.enable_animation) {
            this.draw();
        }
    }

    //
    processScene(scene) {
        let processed = {
            view: {
                prp: CG.Vector3(scene.view.prp[0], scene.view.prp[1], scene.view.prp[2]),
                srp: CG.Vector3(scene.view.srp[0], scene.view.srp[1], scene.view.srp[2]),
                vup: CG.Vector3(scene.view.vup[0], scene.view.vup[1], scene.view.vup[2]),
                clip: [...scene.view.clip]
            },
            models: []
        };

        for (let i = 0; i < scene.models.length; i++) {
            let model = { type: scene.models[i].type };
            if (model.type === 'generic') {
                model.vertices = [];
                model.edges = JSON.parse(JSON.stringify(scene.models[i].edges));
                for (let j = 0; j < scene.models[i].vertices.length; j++) {
                    model.vertices.push(CG.Vector4(scene.models[i].vertices[j][0],
                                                   scene.models[i].vertices[j][1],
                                                   scene.models[i].vertices[j][2],
                                                   1));
                    if (scene.models[i].hasOwnProperty('animation')) {
                        model.animation = JSON.parse(JSON.stringify(scene.models[i].animation));
                    }
                }
            }
            else {
                model.center = CG.Vector4(scene.models[i].center[0],
                                         scene.models[i].center[1],
                                         scene.models[i].center[2],
                                         1);
                for (let key in scene.models[i]) {
                    if (scene.models[i].hasOwnProperty(key) && key !== 'type' && key != 'center') {
                        model[key] = JSON.parse(JSON.stringify(scene.models[i][key]));
                    }
                }
            }

            model.matrix = new Matrix(4, 4);
            processed.models.push(model);
        }

        return processed;
    }

    // Camera's u, v, n, axes
    getCameraAxes() {
        let view = this.scene.view;
        let n = view.prp.subtract(view.srp);
        n.normalize();
        let u = view.vup.cross(n);
        u.normalize();
        let v = n.cross(u);
        return {u: u, v: v, n: n};
    }

    // Move PRP and SRP together by (direction * amount)
    moveCamera(direction, amount) {
        let step = new Vector(3);
        step.values = [direction.x * amount, direction.y * amount, direction.z * amount];
        this.scene.view.prp = this.scene.view.prp.add(step);
        this.scene.view.srp = this.scene.view.srp.add(step);
    }

    // Rotate SRP around the v-axis, with the PRP as the origin
    rotateCamera(theta) {
        let view = this.scene.view;
        let axes = this.getCameraAxes();
        
        // 1. move PRP to orogin
        let to_origin = new Matrix(4, 4);
        CG.mat4x4Translate(to_origin, -view.prp.x, -view.prp.y, -view.prp.z);
        // 2. rotate (u, v, n) onto (x, y, z) -> v_axis becomes the y-axis
        let align = new Matrix(4, 4);
        align.values = [[axes.u.x, axes.u.y, axes.u.z, 0],
                        [axes.v.x, axes.v.y, axes.v.z, 0],
                        [axes.n.x, axes.n.y, axes.n.z, 0],
                        [0, 0, 0, 1]];
        // 3. rotate about y (= v)
        let rotate = new Matrix(4, 4);
        CG.mat4x4RotateY(rotate, theta);
        // 4. undo step 2 (inverse of a rotation = its transpose)
        let unalign = align.transpose();
        // 5. undo step 1
        let back = new Matrix(4, 4);
        CG.mat4x4Translate(back, view.prp.x, view.prp.y, view.prp.z);
 
        let transform = Matrix.multiply([back, unalign, rotate, align, to_origin]);
        let srp = Matrix.multiply([transform, CG.Vector4(view.srp.x, view.srp.y, view.srp.z, 1)]);
        view.srp = CG.Vector3(srp.x, srp.y, srp.z);
    }

    // Build vertices/edges for cube, cone, cylinder and sphere models (once),
    // and find the center of generic models (for animation)
    prepareModels() {
        for (let i = 0; i < this.scene.models.length; i++) {
            let model = this.scene.models[i];
            if (model.hasOwnProperty('vertices') && model.hasOwnProperty('center')) {
                continue;       // already prepared
            }
            if (model.type === 'cube') {
                this.generateCube(model);
            }
            else if (model.type === 'cone') {
                this.generateCone(model);
            }
            else if (model.type === 'cylinder') {
                this.generateCylinder(model);
            }
            else if (model.type === 'sphere') {
                this.generateSphere(model); 
            }
            else {
                // generix: center = average of its vertices
                let cx = 0, cy = 0, cz = 0;
                for (let j = 0; j < model.vertices.length; j++) {
                    cx += model.vertices[j].x;
                    cy += model.vertices[j].y;
                    cz += model.vertices[j].z;
                }
                let count = model.vertices.length;
                model.center = CG.Vector4(cx / count, cy / count, cz / count, 1);
            }
        }
    }

    // Cube: center, width (x), height (y), depth (z)
    generateCube(model) {
        let c = model.center;
        let w = model.width / 2;
        let h = model.height / 2;
        let d = model.depth / 2;
        model.vertices = [
            CG.Vector4(c.x - w, c.y - h, c.z + d, 1), // 0: front bottom left
            CG.Vector4(c.x + w, c.y - h, c.z + d, 1), // 1: front bottom right
            CG.Vector4(c.x + w, c.y + h, c.z + d, 1), // 2: front top right
            CG.Vector4(c.x - w, c.y + h, c.z + d, 1), // 3: front top left
            CG.Vector4(c.x - w, c.y - h, c.z - d, 1), // 4: back bottom left
            CG.Vector4(c.x + w, c.y - h, c.z - d, 1), // 5: back bottom right
            CG.Vector4(c.x + w, c.y + h, c.z - d, 1), // 6: back top right
            CG.Vector4(c.x - w, c.y + h, c.z - d, 1), // 7: back top left
           
        ];
        model.edges = [
            [0, 1, 2, 3, 0],        // front face
            [4, 5, 6, 7, 4],        // back face
            [0, 4], [1, 5], [2, 6], [3, 7]      // front to back
        ];
    }

    // Cone: center of base, radius, height (along +y), sides
    generateCone(model) {
        let c = model.center;
        model.edges = [];
        model.vertices = [];
        let base = [];
        for (let i = 0; i < model.sides; i++) {
            let phi = (2 * Math.PI * i) / model.sides;
            model.vertices.push(CG.Vector4(c.x + model.radius * Math.cos(phi), c.y,
                                           c.z + model.radius * Math.sin(phi), 1));
            base.push(i);
        }
        base.push(0);           // close the base circle
        model.edges.push(base);
        let tip = model.sides;
        model.vertices.push(CG.Vector4(c.x, c.y + model.height, c.z, 1));
        for (let i = 0; i < model.sides; i++) {
            model.edges.push([i, tip]);     // base -> tip
        }
        // rotate about the middle of the cone, not its base
        model.center = CG.Vector4(c.x, c.y + model.height / 2, c.z, 1);
    }

    // Cylinder: center (middle), radius, height (along y), sides
    generateCylinder(model) {
        let c = model.center;
        let h = model.height / 2;
        model.vertices = [];
        model.edges = [];
        let bottom = [];
        let top = [];
        for (let i = 0; i < model.sides; i++) {
            let phi = (2 * Math.PI * i) / model.sides;
            let x = c.x + model.radius * Math.cos(phi);
            let z = c.z + model.radius * Math.sin(phi);
            model.vertices.push(CG.Vector4(x, c.y - h, z, 1));  // 2i: bottom
            model.vertices.push(CG.Vector4(x, c.y + h, z, 1));  // 2i+1: top
            bottom.push(2 * i);
            top.push(2 * i + 1);
            model.edges.push([2 * i, 2 * i + 1]);       // side line
        }
        bottom.push(0);
        top.push(1);
        model.edges.push(bottom);
        model.edges.push(top);
    }

    // Sphere: center, radius, slice (longitude line), stacks (latitude lines)
    generateSphere(model) {
        let c = model.center;
        let r = model.radius;
        model.vertices = [CG.Vector4(c.x, c.y + r, c.z, 1),     // 0: north pole
                          CG.Vector4(c.x, c.y - r, c.z, 1)];    // 1: south pole
        model.edges = [];

        // latitude rings between the poles
        let rings = [];
        for (let i = 1; i <= model.stacks; i++) {
            let theta = (Math.PI * i) / (model.stacks + 1);     // angle down from north pole
            let y = c.y + r * Math.cos(theta);
            let ring_r = r * Math.sin(theta);
            let ring = [];
            for (let j = 0; j < model.slices; j++) {
                let phi = (2 * Math.PI * j) / model.slices;
                ring.push(model.vertices.length);
                model.vertices.push(CG.Vector4(c.x + ring_r * Math.cos(phi), y,
                                               c.z + ring_r * Math.sin(phi), 1));
            }
            rings.push(ring);
            model.edges.push([...ring, ring[0]]);   // closed latitude line
        }

        // longitude lines: north pole -> each ring -> south pole
        for (let j = 0; j < model.slices; j++) {
            let line = [0];
            for (let i = 0; i < rings.length; i++) {
                line.push(rings[i][j]);
            }
            line.push(1);
            model.edges.push(line);
        }
    }

    
    // x0:           float (x coordinate of p0)
    // y0:           float (y coordinate of p0)
    // x1:           float (x coordinate of p1)
    // y1:           float (y coordinate of p1)
    drawLine(x0, y0, x1, y1) {
        this.ctx.strokeStyle = '#000000';
        this.ctx.beginPath();
        this.ctx.moveTo(x0, y0);
        this.ctx.lineTo(x1, y1);
        this.ctx.stroke();

        this.ctx.fillStyle = '#FF0000';
        this.ctx.fillRect(x0 - 2, y0 - 2, 4, 4);
        this.ctx.fillRect(x1 - 2, y1 - 2, 4, 4);
    }
};

//Helper to identify 1 bits in outcode
function isOneBit(code, bitIndex) {
    return (code & (1 << bitIndex)) !== 0;
};

export { Renderer };
